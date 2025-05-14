require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { Pool } = require("pg");
const data = require('./data.js');

// Firebase Admin
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

const { DATABASE_URL, OPENAI_API_KEY } = process.env;

const app = express();
app.use(cors());
app.use(express.json());

// PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});


admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Middleware: Firebase Auth
const checkAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split("Bearer ")[1];
  if (!token) {
    console.log("❌ Missing token");
    return res.status(401).json({ error: "Missing token" });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    console.log("❌ Invalid token", err);
    res.status(403).json({ error: "Unauthorized" });
  }
};

// PostgreSQL version check
async function getPostgresVersion() {
  const client = await pool.connect();
  try {
    const res = await client.query("SELECT version()");
    console.log(res.rows[0]);
  } finally {
    client.release();
  }
}
getPostgresVersion();

// === AI GENERATION ROUTE ===
app.post("/api/generate", async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) return res.status(400).json({ error: "Prompt is required" });
  if (prompt.length > 300)
    return res.status(400).json({
      error: "Prompt is too long. Please limit the prompt to 300 characters.",
    });

  const keywords = prompt.toLowerCase().split(" ");

  let systemPrompts = data
    .filter((item) =>
      item.tags?.split(" ").some((tag) => keywords.includes(tag))
    )
    .map((item) => item.content);

  const chatbotInfoItem = data.find(
    (item) => item.name === "Chatbot Information"
  );
  const chatbotInfo = chatbotInfoItem ? chatbotInfoItem.content : "";

  if (chatbotInfo && systemPrompts.length === 0) {
    systemPrompts.unshift(chatbotInfo);
  }

  if (systemPrompts.length === 1 && systemPrompts[0] === chatbotInfo) {
    systemPrompts = data.map((item) => item.content);
  }

  console.log(
    "Selected object names:",
    data
      .filter((item) =>
        item.tags?.split(" ").some((tag) => keywords.includes(tag))
      )
      .map((item) => item.name)
  );

  try {
    const messages = [
      {
        role: "system",
        content:
          "You are a warm, compassionate chatbot who offers thoughtful, emotionally supportive responses to users feeling down, sad or discouraged...",
      },
      ...systemPrompts.map((content) => ({ role: "system", content })),
      {
        role: "user",
        content: prompt,
      },
    ];

    console.log("Messages sent to OpenAI:", messages);

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4",
        messages,
        max_tokens: 300,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      }
    );

    const { prompt_tokens, completion_tokens, total_tokens } = response.data.usage;
    const reply = response.data.choices[0].message.content;

    res.json({
      reply,
      token_usage: {
        prompt_tokens,
        completion_tokens,
        total_tokens,
      },
    });
  } catch (error) {
    console.error("Error communicating with OpenAI API:", error.message);
    res.status(500).json({ error: "Failed to fetch response from OpenAI." });
  }
});

// POST /api/users - Create user in PostgreSQL
app.post("/api/users", checkAuth, async (req, res) => {
  const { user_id: id, email } = req.user;
  const {
    name,
    gender,
    age,
    profile_pic_url,
    location,
  } = req.body;
  
  const check = await pool.query("SELECT id FROM users WHERE id = $1", [id]);
  if (check.rows.length > 0) {
    return res.status(409).json({ error: "User already exists" });
  }

  try {
    const query = `
      INSERT INTO users (id, email, name, gender, age, profile_pic_url, location)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE
      SET email = $2, name = $3, gender = $4, age = $5, profile_pic_url = $6, location = $7
      RETURNING id, email, name, gender, age, profile_pic_url, location;
    `;
    await pool.query(query, [
      id,
      email,
      name,
      gender,
      age,
      profile_pic_url,
      location,
    ]);
    res.header("Access-Control-Allow-Origin", "*");
    res.status(201).json({ message: "User added to PostgreSQL" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database insertion failed" });
  }
});

app.get("/api/users", checkAuth, async (req, res) => {
  const { user_id } = req.user;

  try {
    const result = await pool.query("SELECT id, email, name, gender, age, profile_pic_url, location FROM users WHERE id = $1", [user_id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching user:", err);
    res.status(500).json({ error: "Database fetch failed" });
  }
});

app.put("/api/users", checkAuth, async (req, res) => {
  const { user_id } = req.user;
  const { name, gender, age, profile_pic_url, location } = req.body;

  try {
    const query = `
      UPDATE users
      SET name = $1, gender = $2, age = $3, profile_pic_url = $4, location = $5
      WHERE id = $6
      RETURNING id, email, name, gender, age, profile_pic_url, location;
    `;
    const values = [name, gender, age, profile_pic_url, location, user_id];
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error("Error updating user:", err);
    res.status(500).json({ error: "Database update failed" });
  }
});

// === LOGS ===
app.get("/logs/user/:user_id", async (req, res) => {
  const { user_id } = req.params;
  const client = await pool.connect();
  try {
    const result = await pool.query("SELECT * FROM logs WHERE user_id = $1", [
      user_id,
    ]);
    if (result.rowCount > 0) {
      res.json(result.rows);
    } else {
      res.status(404).json({ error: "No logs found for this user" });
    }
  } catch (error) {
    console.error("Error", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.post("/logs", async (req, res) => {
  const {
    user_id,
    mood,
    energy_level,
    sleep_hours,
    sleep_quality,
    night_awakenings,
    medication_taken,
    journal,
    anxiety_level,
    irritability_level,
    stress_level,
    cognitive_clarity,
    negative_thoughts,
    intrusive_thoughts,
    intrusive_thoughts_description,
    social_interaction_level,
    physical_activity_level,
    screen_time_minutes,
    substance_use,
    medication_details,
    gratitude_entry,
    psychotic_symptoms,
    image_url,
  } = req.body;
  const client = await pool.connect();
  try {
    const result = await client.query(
      `INSERT INTO logs (user_id, mood, energy_level, sleep_hours, sleep_quality, night_awakenings, medication_taken, journal, anxiety_level, irritability_level, stress_level, cognitive_clarity, negative_thoughts, intrusive_thoughts, intrusive_thoughts_description, social_interaction_level, physical_activity_level, screen_time_minutes, substance_use, medication_details, gratitude_entry, psychotic_symptoms, image_url, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, CURRENT_TIMESTAMP) RETURNING *`,
      [
        user_id,
        mood,
        energy_level,
        sleep_hours,
        sleep_quality,
        night_awakenings,
        medication_taken,
        journal,
        anxiety_level,
        irritability_level,
        stress_level,
        cognitive_clarity,
        negative_thoughts,
        intrusive_thoughts,
        intrusive_thoughts_description,
        social_interaction_level,
        physical_activity_level,
        screen_time_minutes,
        substance_use,
        medication_details,
        gratitude_entry,
        psychotic_symptoms,
        image_url,
      ],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("🔥 Error inserting log:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put("/logs/:log_id", async (req, res) => {
  const { log_id } = req.params;
  const fields = req.body;

  const keys = Object.keys(fields);
  const values = Object.values(fields);

  const setQuery = keys.map((key, i) => `${key} = $${i + 1}`).join(", ");

  try {
    console.log("Incoming update data:", req.body);
    const result = await pool.query(
      `UPDATE logs SET ${setQuery} WHERE id = $${keys.length + 1} RETURNING *`,
      [...values, log_id],
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating log:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.delete("/logs/:log_id", async (req, res) => {
  const { log_id } = req.params;
  try {
    await pool.query("DELETE FROM logs WHERE id = $1", [log_id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting log:", err.stack);
    res.status(500).json({ error: "Failed to delete log" });
  }
});

app.get("/timeline/:user_id", async (req, res) => {
  const { user_id } = req.params;
  const client = await pool.connect();

  try {
    const logsResult = await pool.query(
      "SELECT * FROM logs WHERE user_id = $1 ORDER BY created_at DESC", 
      [user_id]
    );

    const response = {
      weeklyData: [],
      currentStreak: 0,
    };

    const today = new Date();
    const currentDay = today.getDay(); 
    const sunday = new Date(today);
    sunday.setDate(today.getDate() - currentDay);

    for (let i = 0; i < 7; i++) {
      const date = new Date(sunday);
      date.setDate(sunday.getDate() + i);

      response.weeklyData.push({
        dayIndex: i,
        date: date.toISOString().split('T')[0],
        dayName: date.toLocaleString('en-US', { weekday: 'short' }),
        hasLog: false
      });
    }

    if (logsResult.rowCount === 0) {
      return res.json(response);
    }

    const logs = logsResult.rows;

    logs.forEach(log => {
      const logDate = new Date(log.created_at);
      const logDateStr = logDate.toISOString().split('T')[0];
      response.weeklyData.forEach(day => {
        if (day.date === logDateStr) {
          day.hasLog = true;
        }
      });
    });

    let currentStreak = 0;

    const todayStr = today.toLocaleDateString();
    let yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toLocaleDateString();

    const logDatesMap = {};
    logs.forEach(log => {
      const dateStr = new Date(log.created_at).toLocaleDateString();
      logDatesMap[dateStr] = true;
    });

    const streakActive = logDatesMap[todayStr] || logDatesMap[yesterdayStr];

    if (streakActive) {
      currentStreak = 0;
      let checkDate = new Date();

      if (logDatesMap[todayStr]) {
        currentStreak = 1;
      } else {
        checkDate = yesterday;
      }

      while (logDatesMap[checkDate.toLocaleDateString()]) {
        if (checkDate !== today || !logDatesMap[todayStr]) {
          currentStreak++;
        }
        checkDate.setDate(checkDate.getDate() - 1);
      }
    }

    response.currentStreak = currentStreak;

    res.json(response);

  } catch (error) {
    console.error("Error calculating streaks:", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// === ALARMS CRUD ===
app.get("/alarms/user/:user_id", async (req, res) => {
  const { user_id } = req.params;
  const client = await pool.connect();
  try {
    const alarms = await client.query(
      "SELECT * FROM alarms WHERE user_id = $1",
      [user_id],
    );
    res.json(alarms.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post("/alarms", async (req, res) => {
  const { user_id, type, time, label, checklist, sound_url, date, reminder, isEnabled = true } =
    req.body;
  const client = await pool.connect();
  try {
    const result = await client.query(
      `INSERT INTO alarms (user_id, type, time, label, checklist, created_at, sound_url, date, reminder, "isEnabled")
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6, $7, $8, $9) RETURNING *`,
      [
        user_id,
        type,
        time,
        label,
        checklist,
        sound_url,
        date,
        reminder,
        isEnabled,
      ],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("🔥 Error inserting alarm:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put("/alarms/:id", async (req, res) => {
  const { id } = req.params;
  const { type, time, label, checklist, sound_url, date, reminder, isEnabled = true } =
    req.body;
  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE alarms SET type=$1, time=$2, label=$3, checklist=$4, sound_url=$5, date=$6, reminder=$7, "isEnabled"=$8 WHERE id=$9 RETURNING *`,
      [type, time, label, checklist, sound_url, date, reminder, isEnabled, id],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("🔥 Error updating alarm:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete("/alarms/:id", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("DELETE FROM alarms WHERE id = $1", [id]);
    res.json({ message: "Alarm deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// === CONTACTS CRUD ===
app.get("/contacts/user/:user_id", async (req, res) => {
  const { user_id } = req.params;
  const client = await pool.connect();
  try {
    const contacts = await client.query(
      "SELECT * FROM emergency_contacts WHERE user_id = $1",
      [user_id],
    );
    res.json(contacts.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post("/contacts", async (req, res) => {
  const { user_id, name, phone } = req.body;
  const client = await pool.connect();
  try {
    const result = await client.query(
      `INSERT INTO emergency_contacts (user_id, name, phone) VALUES ($1, $2, $3) RETURNING *`,
      [user_id, name, phone],
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put("/contacts/:id", async (req, res) => {
  const { id } = req.params;
  const { name, phone } = req.body;
  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE emergency_contacts SET name=$1, phone=$2 WHERE id=$3 RETURNING *`,
      [name, phone, id],
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete("/contacts/:id", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("DELETE FROM emergency_contacts WHERE id = $1", [id]);
    res.json({ message: "Contact deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// === SAFETY PLAN CRUD ===
app.get("/safety-plans/user/:user_id", async (req, res) => {
  const { user_id } = req.params;
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT * FROM safety_plans WHERE user_id = $1",
      [user_id],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post("/safety-plans", async (req, res) => {
  const {
    user_id,
    warning_signs,
    coping_strategies,
    safe_places,
    reasons_for_living,
  } = req.body;
  const client = await pool.connect();
  try {
    const result = await client.query(
      `INSERT INTO safety_plans (user_id, warning_signs, coping_strategies, safe_places, reasons_for_living)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        user_id,
        warning_signs,
        coping_strategies,
        safe_places,
        reasons_for_living,
      ],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put("/safety-plans/:id", async (req, res) => {
  const { id } = req.params;
  const { warning_signs, coping_strategies, safe_places, reasons_for_living } =
    req.body;
  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE safety_plans
       SET warning_signs = $1,
           coping_strategies = $2,
           safe_places = $3,
           reasons_for_living = $4
       WHERE id = $5
       RETURNING *`,
      [warning_signs, coping_strategies, safe_places, reasons_for_living, id],
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete("/safety-plans/:id", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("DELETE FROM safety_plans WHERE id = $1", [id]);
    res.json({ message: "Safety plan deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// === WELLNESS PLAN CRUD ===
app.get("/wellness-plan/user/:user_id", async (req, res) => {
  const { user_id } = req.params;
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT * FROM wellness_plans WHERE user_id = $1",
      [user_id],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post("/wellness-plan", async (req, res) => {
  const { user_id, items } = req.body;
  const client = await pool.connect();
  try {
    const existing = await client.query(
      "SELECT id FROM wellness_plans WHERE user_id = $1",
      [user_id],
    );
    if (existing.rows.length > 0) {
      const result = await client.query(
        "UPDATE wellness_plans SET items = $1 WHERE user_id = $2 RETURNING *",
        [items, user_id],
      );
      res.json(result.rows[0]);
    } else {
      const result = await client.query(
        "INSERT INTO wellness_plans (user_id, items) VALUES ($1, $2) RETURNING *",
        [user_id, items],
      );
      res.json(result.rows[0]);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete("/wellness-plan/item", async (req, res) => {
  const { user_id, label } = req.query; 
  const client = await pool.connect();
  try {
    const result = await client.query(
      "UPDATE wellness_plans SET items = array_remove(items, $1) WHERE user_id = $2 RETURNING *",
      [label, user_id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get("/", (req, res) => {
  res.status(200).json({ message: "Welcome to the Capstone Project API!" });
});

app.listen(3000, () => {
  console.log("App is listening on port 3000");
});

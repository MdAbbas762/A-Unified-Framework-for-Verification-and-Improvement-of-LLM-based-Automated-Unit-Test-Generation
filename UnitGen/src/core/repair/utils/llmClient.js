// src/core/repair/utils/llmClient.js

import OpenAI from "openai";
import "dotenv/config";

/* ======================================================
   🔥 CONFIG (SAFE DEFAULTS)
====================================================== */

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-3.5-turbo";
const MAX_RETRIES = 2; // 👉 3 total attempts (0,1,2)
const REQUEST_TIMEOUT = 90000; // 🔥 90 seconds

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ======================================================
   🔥 TIMEOUT WRAPPER
====================================================== */

function withTimeout(promise, timeout = REQUEST_TIMEOUT) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("LLM request timeout")), timeout)
    ),
  ]);
}

/* ======================================================
   🔥 RESPONSE VALIDATION
====================================================== */

function isValidLLMResponse(text) {
  if (!text || typeof text !== "string") return false;

  // Must contain JSON hint OR array
  if (!text.includes("<JSON>") && !/\[\s*{/.test(text)) {
    return false;
  }

  return true;
}

/* ======================================================
   🔥 MAIN LLM CALL (WITH RETRY + SAFETY)
====================================================== */

export async function callLLM({
  prompt,
  model = DEFAULT_MODEL,
  temperature = 0.2,
}) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(
        `🤖 OpenAI LLM Request (Attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );

      if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is missing. Add it to backend/.env");
      }

      const response = await withTimeout(
        client.chat.completions.create({
          model,
          temperature,
          messages: [
            {
              role: "system",
              content:
                "You are a specialized JavaScript Jest test repair agent. Fix failing generated tests. Preserve the requested output format. Return only the requested JSON or code format, without extra explanation.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
        })
      );

      const text = response.choices?.[0]?.message?.content?.trim();

      if (!text) {
        throw new Error("Empty response from OpenAI");
      }

      /* ======================================================
         🔥 VALIDATION CHECK (CRITICAL)
      ====================================================== */

      if (!isValidLLMResponse(text)) {
        throw new Error("Invalid LLM format (no JSON detected)");
      }

      console.log("✅ OpenAI LLM response received");
      return text;
    } catch (err) {
      lastError = err;

      console.warn(
        `⚠️ OpenAI LLM attempt ${attempt + 1} failed:`,
        err.message
      );

      /* ======================================================
         🔥 RETRY LOGIC
      ====================================================== */

      if (attempt < MAX_RETRIES) {
        await new Promise((res) => setTimeout(res, 500));
        continue;
      }
    }
  }

  console.error(
    "❌ OpenAI LLM Client Failed after retries:",
    lastError?.message
  );

  return null;
}
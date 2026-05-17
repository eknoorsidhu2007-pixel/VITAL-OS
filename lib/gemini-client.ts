/**
 * Server-side Gemini client. Do not import from client components.
 */

import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("Missing GEMINI_API_KEY environment variable");
}

export const gemini = new GoogleGenAI({ apiKey });

export const GEMINI_CLINICAL_MODEL =
  process.env.GEMINI_CLINICAL_MODEL?.trim() || "gemini-2.0-flash";

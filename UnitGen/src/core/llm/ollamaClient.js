// src/core/llm/ollamaClient.js
export async function ollamaGenerate({
  model = "qwen2.5:1.5b",
  prompt,
  temperature = 0.2,
}) {
  const res = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama request failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.response ?? "";
}

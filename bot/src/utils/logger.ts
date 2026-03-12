import { config } from "../config.js";

export function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

export function logError(message: string): void {
  console.error(`[${new Date().toISOString()}] ERROR: ${message}`);
}

export async function notify(message: string): Promise<void> {
  log(message);

  if (!config.discordWebhookUrl) return;

  try {
    await fetch(config.discordWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
  } catch {
    logError("Failed to send Discord notification");
  }
}

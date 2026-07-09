import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadFramework(id) {
  const filePath = path.join(__dirname, `${id}.json`);
  const framework = JSON.parse(readFileSync(filePath, "utf-8"));
  if (!framework.id || !Array.isArray(framework.dimensions)) {
    throw new Error(`Framework "${id}" is missing required fields (id, dimensions)`);
  }
  return framework;
}

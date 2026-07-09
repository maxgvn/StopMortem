import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { router as apiRouter } from "./routes/api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = 3000;

app.use(express.json());
app.use("/api", apiRouter);
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`StopMortem listening on http://localhost:${PORT}`);
});

import fs from "fs";
import path from "path";
import os from "os";

const root = process.cwd();
const dataDir = path.join(os.homedir(), ".whataboutthisbook");
const envDest = path.join(dataDir, ".env");
const envSrc = path.join(root, ".env");
const exampleSrc = path.join(root, ".env.example");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

if (!fs.existsSync(envDest)) {
  if (fs.existsSync(envSrc)) {
    fs.copyFileSync(envSrc, envDest);
    console.log(`Created ${envDest} from project .env`);
  } else if (fs.existsSync(exampleSrc)) {
    fs.copyFileSync(exampleSrc, envDest);
    console.log(`Created ${envDest} from .env.example`);
  }
} else {
  console.log(`Already exists: ${envDest}`);
}

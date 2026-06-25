import fs from "fs";
import path from "path";
import sharp from "sharp";

const srcDir = path.resolve(process.cwd(), "public", "img");
const outDir = path.resolve(process.cwd(), "src", "img");

if (!fs.existsSync(srcDir)) {
  console.error("Source directory does not exist:", srcDir);
  process.exit(1);
}
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const files = fs.readdirSync(srcDir).filter((f) => /\.(jpe?g|png|webp|avif|gif)$/i.test(f));

if (!files.length) {
  console.log("No images found in", srcDir);
  process.exit(0);
}

for (const file of files) {
  const input = path.join(srcDir, file);
  const name = path.parse(file).name + ".webp";
  const out = path.join(outDir, name);
  try {
    await sharp(input).webp({ quality: 80 }).toFile(out);
    console.log("converted", file, "→", path.relative(process.cwd(), out));
  } catch (err) {
    console.error("failed", file, err.message || err);
  }
}

console.log("Done.");

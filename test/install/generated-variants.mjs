import { readFileSync } from "node:fs";

const [installerPath, configPath] = process.argv.slice(2);
if (!installerPath || !configPath) {
  console.error("usage: generated-variants.mjs <install.sh> <binary.config.json>");
  process.exit(2);
}

const installer = readFileSync(installerPath, "utf-8");
const lines = installer.split("\n");
const { installer: installerConfig } = JSON.parse(readFileSync(configPath, "utf-8"));
const prefix = installerConfig.environmentPrefix;

function encode(text) {
  return text.split("\n").join("\\n");
}

function emit(name, oldText, newText) {
  if (!installer.includes(oldText)) {
    console.error(`the installer does not contain the text for the ${name} variant`);
    process.exit(1);
  }
  process.stdout.write(`${name}|||${encode(oldText)}|||${encode(newText)}\n`);
}

function unsupportedPlatformHelp() {
  const start = lines.findIndex((line) => line.endsWith("This machine reports $platform."));
  const end = lines.findIndex((line, index) => index > start && line.endsWith('"'));
  if (start < 0 || end < 0) {
    console.error("the installer has no unsupported platform message");
    process.exit(1);
  }
  return lines
    .slice(start + 2, end + 1)
    .join("\n")
    .slice(0, -1);
}

function documentedOverride(suffix) {
  const line = lines.find((candidate) => candidate.startsWith(`  ${prefix}_${suffix}`));
  if (!line) {
    console.error(`the installer help does not document ${prefix}_${suffix}`);
    process.exit(1);
  }
  return line;
}

const help = unsupportedPlatformHelp();
emit("the unsupported platform help is dropped", help, "Install the plugin instead.");

const indented = help.split("\n").find((line) => line.startsWith("  ") && line.trim() !== "");
if (!indented) {
  console.error("the unsupported platform message has no indented command to unindent");
  process.exit(1);
}
emit("the unsupported platform help loses its indentation", indented, indented.trimStart());

emit("the releases API override is undocumented", documentedOverride("RELEASES_API"), "");
emit("the download base override is undocumented", documentedOverride("DOWNLOAD_BASE"), "");

emit(
  "the help footer is replaced with something generic",
  installerConfig.helpFooter.join("\n"),
  "Ask your team how to install this.",
);

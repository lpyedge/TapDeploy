import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { zipSync, strToU8 } from "fflate";

mkdirSync("temp/test/public-artifact", { recursive: true });
const root = mkdtempSync("temp/test/public-artifact/run-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const secret = "CWI_SYNTHETIC_" + "SECRET_doNotPrint123";
function scan(files: Record<string, Uint8Array>, name = "artifact.zip") {
  const path = join(root, name);
  writeFileSync(path, zipSync(files));
  const result = spawnSync("python3", ["-B", "scripts/scan-public-artifact.py", path], { encoding: "utf8" });
  expect(result.stdout).not.toContain(secret);
  expect(result.stderr).not.toContain(secret);
  return result;
}

describe("public artifact scanner", () => {
  it("accepts clean nested archives", () => {
    expect(scan({ "src/app.js": strToU8("export default 1"), "nested.zip": zipSync({ "README.md": strToU8("clean") }) }).status).toBe(0);
  });
  it.each([".env.local", "plan/private.json", ".wrangler/state.json", "auth.har", "storageState.json", "trace.zip", "../escape.txt"])("rejects nested private path %s without printing contents", (path) => {
    expect(scan({ "nested.zip": zipSync({ [path]: strToU8(secret) }) }).status).toBe(1);
  });
  it("detects content secrets and disguised nested ZIPs", () => {
    expect(scan({ "data.bin": zipSync({ "allowed.json": strToU8(secret) }) }).status).toBe(1);
  });
  it("inspects a nested gzip tar without extracting files", () => {
    const tar = spawnSync("python3", ["-c", "import io,tarfile,sys; b=io.BytesIO(); t=tarfile.open(fileobj=b,mode='w:gz'); x=tarfile.TarInfo('.env.local'); x.size=3; t.addfile(x,io.BytesIO(b'bad')); t.close(); sys.stdout.buffer.write(b.getvalue())"]);
    expect(tar.status).toBe(0);
    expect(scan({ "nested.tar.gz": tar.stdout }).status).toBe(1);
  });
  it("fails closed on malformed archives", () => {
    expect(scan({ "broken.zip": strToU8("not a ZIP") }).status).toBe(1);
  });
  it("rejects nested private keys by type without echoing them", () => {
    const key = "-----BEGIN " + "PRIVATE KEY-----\nsynthetic";
    const result = scan({ "innocent.txt": strToU8(key) });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("private-key");
    expect(result.stdout).not.toContain(key);
  });
});

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type OfflineCandidate = {
  format: "coderook-offline-candidate-v1";
  createdAt: string;
  repositoryId: string | null;
  baseVersionId: string | null;
  message: string;
  files: Array<{ path: string; sha256: string; size: number }>;
};

export async function queueOfflineCandidate(folder: string, candidate: Omit<OfflineCandidate, "format" | "createdAt">): Promise<string> {
  const directory = path.join(folder, ".coderook", "outbox");
  await mkdir(directory, { recursive: true });
  const body: OfflineCandidate = {
    format: "coderook-offline-candidate-v1",
    createdAt: new Date().toISOString(),
    ...candidate,
  };
  const name = `${Date.now()}-${crypto.randomUUID()}.json`;
  const destination = path.join(directory, name);
  await writeFile(destination, JSON.stringify(body, null, 2), { encoding: "utf8", mode: 0o600 });
  return destination;
}

export async function readOfflineCandidate(file: string): Promise<OfflineCandidate> {
  const value = JSON.parse(await readFile(file, "utf8")) as OfflineCandidate;
  if (value.format !== "coderook-offline-candidate-v1") throw new Error("Unsupported offline candidate");
  return value;
}

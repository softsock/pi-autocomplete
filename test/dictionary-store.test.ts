import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PersonalDictionaryStore } from "../src/dictionary/store.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "ghost-dictionary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "personal-v1.json");
}
const options = {
  common: [] as [string, number][],
  now: () => 1_800_000_000_000,
  debounceMs: 60_000,
};

test("store merges concurrent writers without double counting and survives restart", async (t) => {
  const path = await fixture(t);
  const a = new PersonalDictionaryStore(path, options),
    b = new PersonalDictionaryStore(path, options);
  await Promise.all([a.load(), b.load()]);
  a.recordPrompt("capricorn capricorn");
  b.recordPrompt("capricorn again");
  await Promise.all([a.persist(), b.persist()]);
  await a.persist();
  const state = JSON.parse(await readFile(path, "utf8"));
  assert.equal(
    state.words.find((w: { word: string }) => w.word === "capricorn")
      .promptCount,
    2,
  );
  const c = new PersonalDictionaryStore(path, options);
  await c.load();
  assert.equal(c.lookup("capric")?.suffix, "orn");
  await Promise.all([a.close(), b.close(), c.close()]);
});

test("observations before load and during deferred reads survive load and close", async (t) => {
  const path = await fixture(t);
  let release!: (text: string) => void;
  let first = true;
  const store = new PersonalDictionaryStore(path, {
    ...options,
    read: (p) => {
      if (first) {
        first = false;
        return new Promise<string>((r) => {
          release = r;
        });
      }
      return readFile(p, "utf8");
    },
  });
  store.recordPrompt("capricorn");
  const loading = store.load();
  await new Promise((r) => setImmediate(r));
  store.recordPrompt("capricorn");
  release('{"version":1,"words":[],"pairs":[]}');
  await loading;
  assert.equal(store.lookup("capric")?.suffix, "orn");
  await store.close();
  const before = await readFile(path, "utf8");
  store.recordPrompt("ignoredword");
  await store.persist();
  assert.equal(await readFile(path, "utf8"), before);
});

test("corrupt and unsupported states recover with common dictionary and diagnostics", async (t) => {
  const path = await fixture(t);
  for (const data of [
    "{",
    '{"version":8}',
    '{"version":1,"words":[{"word":"poison","promptCount":-1,"updatedAt":0}],"pairs":[]}',
  ]) {
    await writeFile(path, data);
    const warnings: string[] = [];
    const s = new PersonalDictionaryStore(path, {
      ...options,
      common: [["because", 0.001]],
      onDiagnostic: (m) => warnings.push(m),
    });
    await s.load();
    assert.equal(s.lookup("becau")?.suffix, "se");
    assert.equal(s.lookup("pois"), undefined);
    if (!data.includes("poison")) assert.equal(warnings.length, 1);
    await s.close();
  }
});

test("lock timeout retains pending data for retry; clear removes learned vocabulary", async (t) => {
  const path = await fixture(t),
    warnings: string[] = [];
  const s = new PersonalDictionaryStore(path, {
    ...options,
    lockTimeoutMs: 30,
    onDiagnostic: (m) => warnings.push(m),
  });
  await s.load();
  s.recordAcceptance("capric", "orn");
  await mkdir(path + ".lock");
  await assert.rejects(s.persist(), /lock/);
  assert.equal(s.lookup("capric")?.suffix, "orn");
  await rm(path + ".lock", { recursive: true });
  await s.persist();
  assert.equal(JSON.parse(await readFile(path, "utf8")).pairs.length, 1);
  await s.clear();
  assert.equal(s.lookup("capric"), undefined);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    version: 1,
    words: [],
    pairs: [],
  });
  await s.close();
});

test("failed writes retain pending observations and close reports unsaved data", async (t) => {
  const path = await fixture(t),
    warnings: string[] = [];
  const s = new PersonalDictionaryStore(path, {
    ...options,
    onDiagnostic: (m) => warnings.push(m),
  });
  await s.load();
  s.recordPrompt("capricorn");
  s.recordPrompt("capricorn");
  await mkdir(path);
  await assert.rejects(s.persist());
  assert.equal(s.lookup("capric")?.suffix, "orn");
  await s.close();
  assert.ok(warnings.some((w) => /unsaved/i.test(w)));
});

// Keep Cyrillic vocabulary available across sessions without adding language configuration.
test("Cyrillic prompts and accepted words survive a dictionary restart", async (t) => {
  const path = await fixture(t);
  const entries = [
    ["працювати", "прац", "ювати"],
    ["разработка", "разр", "аботка"],
    ["прывітанне", "прыв", "ітанне"],
    ["съобщение", "съоб", "щение"],
    ["љубав", "љуб", "ав"],
    ["ѕвезда", "ѕве", "зда"],
    ["пам’ятати", "пам’", "ятати"],
  ];
  const store = new PersonalDictionaryStore(path, options);
  t.after(() => store.close());
  await store.load();
  const prompt = entries.map(([word]) => word).join(" ") + " implementation";
  store.recordPrompt(prompt + " " + prompt);
  for (const [, prefix] of entries)
    assert.equal(store.lookup(prefix), undefined, prefix);
  store.recordPrompt(prompt);
  store.recordAcceptance("перев", "іряти");
  await store.close();

  const state = JSON.parse(await readFile(path, "utf8"));
  for (const [word] of entries) {
    const saved = state.words.find(
      (entry: { word: string }) => entry.word === word.replaceAll("’", "'"),
    );
    assert.equal(saved?.promptCount, 2, word);
  }
  const reopened = new PersonalDictionaryStore(path, options);
  t.after(() => reopened.close());
  await reopened.load();
  for (const [, prefix, suffix] of entries) {
    assert.equal(reopened.lookup(prefix)?.suffix, suffix, prefix);
    assert.equal(
      reopened.lookup(prefix.toUpperCase())?.suffix,
      suffix.toUpperCase(),
      prefix,
    );
  }
  assert.equal(reopened.lookup("перев")?.suffix, "іряти");
  assert.equal(reopened.lookup("imple")?.suffix, "mentation");
  assert.equal(reopened.lookup("ghfw"), undefined);
});

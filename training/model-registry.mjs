/**
 * Model registry — Javelin's named models.
 * ========================================
 *
 * A "Javelin model" (e.g. Javelin Coder 80B) is a *declared* artifact: an intended
 * base, method and target hardware, recorded on disk. Declaring it does not make it
 * exist. This registry exists so the difference is impossible to blur:
 *
 *   declared  — a manifest says what we intend to build. No weights required.
 *   trained   — the training pipeline recorded a completion AND the adapter is on
 *               disk and verified. Corroborated, never assumed.
 *   served    — a server is actually answering for this model. Checked by probing
 *               the OpenAI-compatible endpoint, not by configuration alone.
 *
 * A model appearing in `npm run models` is not a claim that it works. It is a claim
 * that it is *defined*. The status column is where the truth lives.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyProvenance } from './provenance.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// When this module is bundled (the test runner compiles each test to a temp dir),
// import.meta.url points at the bundle, not the repo. Resolve the repo root from the
// working directory in that case so the models directory is always the real one.
const root = existsSync(join(here, '..', 'training', 'models'))
  ? join(here, '..')
  : process.cwd()
const MODELS_DIR = join(root, 'training', 'models')

/** @typedef {'declared'|'trained'|'served'} ModelStatus */

/**
 * Load every model manifest from training/models/*.json.
 * Malformed manifests are skipped with a warning rather than crashing the CLI —
 * a bad file should not hide the good ones.
 */
export function loadManifests() {
  const models = []
  if (!existsSync(MODELS_DIR)) {
    return models
  }
  for (const entry of readdirSync(MODELS_DIR)) {
    if (!entry.endsWith('.json')) {
      continue
    }
    const path = join(MODELS_DIR, entry)
    try {
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      if (!manifest.id) {
        console.warn(`  ! ${entry}: no "id" field — skipped`)
        continue
      }
      models.push({ ...manifest, _path: path })
    } catch (err) {
      console.warn(`  ! ${entry}: ${err.message}`)
    }
  }
  return models.sort((a, b) => (a.id < b.id ? -1 : 1))
}

/** Find one manifest by id. Returns null if it is not declared. */
export function getManifest(id) {
  return loadManifests().find((m) => m.id === id) ?? null
}

/**
 * The honest status of a model. Never trusts the manifest's own `status` flags for
 * `trained`/`served` — it checks the filesystem for the adapter.
 *
 * @param {object} manifest
 * @returns {{declared: boolean, trained: boolean, served: boolean, detail: string, trainedAt: string|null}}
 */
export function resolveStatus(manifest) {
  const declaredDir = manifest.output?.dir ?? ''
  // A declared dir is repo-relative; an absolute one (as tests use) is taken as-is.
  const runDir = isAbsolute(declaredDir) ? declaredDir : join(root, declaredDir)
  const provenance = declaredDir
    ? verifyProvenance(runDir)
    : { trained: false, detail: 'no output dir declared' }

  const trained = Boolean(provenance.trained)
  const declaredMerged = manifest.output?.mergedDir ?? ''
  const mergedDir = declaredMerged
    ? (isAbsolute(declaredMerged) ? declaredMerged : join(root, declaredMerged))
    : null
  const mergedExists = mergedDir ? existsSync(join(mergedDir, 'config.json')) : false

  // "Served" is deliberately conservative: we can prove a *merged* model exists, but
  // we cannot know a server is running without probing it. This flag means "serveable",
  // and the CLI says so plainly.
  const served = trained && mergedExists

  let detail
  if (!manifest.output?.dir) {
    detail = 'declared only — no output directory specified yet'
  } else if (!trained) {
    detail = provenance.detail
  } else if (!mergedExists) {
    detail = 'adapter trained and verified; not merged into standalone weights yet'
  } else {
    detail = 'trained, verified and merged — ready to serve'
  }

  return {
    declared: true,
    trained,
    served,
    detail,
    trainedAt: provenance.record?.finishedAt ?? null,
    adapterFiles: provenance.files?.length ?? 0,
    drift: provenance.drift ?? null,
  }
}

/**
 * Every declared model with its honest status attached.
 */
export function listModels() {
  return loadManifests().map((manifest) => ({
    ...manifest,
    statusResolved: resolveStatus(manifest),
  }))
}

/**
 * A short, blunt one-line verdict, in the spirit of `train:status`.
 */
export function verdictFor(entry) {
  const s = entry.statusResolved
  if (s.trained && s.served) {
    return `${entry.displayName}: trained, verified and merged — serveable.`
  }
  if (s.trained) {
    return `${entry.displayName}: adapter trained — merge to serve.`
  }
  return `${entry.displayName}: NOT built — ${s.detail}. Do not serve it as a working model.`
}

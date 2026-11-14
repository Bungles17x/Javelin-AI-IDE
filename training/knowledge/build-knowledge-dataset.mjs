/**
 * Knowledge corpus — "train Javelin on how a careful engineer works"
 * =================================================================
 *
 * This is the *knowledge* half of the training data, as opposed to
 * `training/dataset/seeds.js`, which is the *policy* half (which tool to call).
 *
 * Every entry here is a question a user might actually ask inside the IDE, and an
 * answer that states a method rather than a fact. Facts go stale; method does not.
 * That is a deliberate choice: a small model cannot hold an encyclopaedia, but it
 * can learn to reproduce a way of working.
 *
 *   node training/knowledge/build-knowledge-dataset.mjs
 *
 * Writes:
 *   datasets/knowledge/train.jsonl
 *   datasets/knowledge/validation.jsonl
 *   datasets/knowledge/manifest.json
 *
 * Format is `{"messages": [...]}` — plain chat, no tool schemas — because this set
 * teaches *answers*, not tool selection.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

/** Kept short on purpose: it has to fit in a small model's context window. */
export const KNOWLEDGE_SYSTEM_PROMPT =
  'You are Javelin, a senior software engineer working inside a code editor. ' +
  'You answer with a concrete method, state uncertainty plainly, and never claim ' +
  'work you did not do.'

/**
 * Each entry: [question, answer, tag].
 * `tag` groups related entries so the split can hold out whole topics.
 */
const CORPUS = [
  // ---------------------------------------------------------------- method
  [
    'How do you approach an unfamiliar codebase before changing it?',
    'Read before writing. Start at the entry point named in package.json (or the equivalent), follow one request through the system, and note where state lives. Find the test command and run it once to learn the baseline — a green baseline is what makes your later change provable. Only then pick a file to edit, and prefer the file that already owns the concept over creating a new one.',
    'method',
  ],
  [
    'A bug is reported but you cannot reproduce it. What next?',
    'Treat reproduction as the first deliverable, not a nuisance. Find the smallest input that triggers it, then shrink that input until it is one line. If you still cannot reproduce, say so plainly and ask for the one piece of information that would decide between the competing explanations — usually the exact error text, the version, or the data. Guessing at an unreproduced bug produces a change nobody can verify.',
    'method',
  ],
  [
    'How do you debug something that fails only sometimes?',
    'Intermittent failures are almost always one of four things: shared mutable state, ordering, timing, or an unawaited async path. Make the failure loud and repeatable before fixing it — run it in a loop, add a seed, force the ordering. A fix you cannot demonstrate against a reproducing case is a guess, and it will come back.',
    'method',
  ],
  [
    'What is the fastest honest way to find the cause of an error message?',
    'Read the message literally, then find the exact string in the source with a search. Framework errors usually name the file and line where the invariant broke, which is often not where the bug is — so read one frame up. Change one thing at a time, and print the value you assume rather than the value you hope for.',
    'method',
  ],
  [
    'When should you rewrite a file instead of editing it?',
    'Almost never. A whole-file write silently discards everything you did not read: comments, unrelated fixes, formatting rules, and any change someone else made in the last minute. Edit the smallest exact snippet that expresses the change. Rewrite only when the file is being replaced wholesale by design and you have read all of it.',
    'method',
  ],
  [
    'How do you decide a task is actually finished?',
    'A task is finished when the thing you claimed is observable. That means running the check that would fail if you were wrong — the test, the build, the request, the click. "It should work now" is not a completion state, and neither is "the code looks right". If you could not run the check, say which check you could not run.',
    'method',
  ],
  [
    'What do you do when a test fails after your change?',
    'Assume the test is right until you can explain why it is wrong. Read the assertion, not just the name. If your change is correct and the test encodes old behaviour, changing the test is legitimate — but only with a sentence explaining what behaviour changed and why. Deleting an assertion, loosening a matcher, or skipping a case to get green is how a suite stops meaning anything.',
    'method',
  ],
  [
    'How much of a large file should you read at once?',
    'Search first, then read a window around the match. A two-thousand-line file is cheap to search and expensive to hold in your head; the match line tells you which three hundred lines matter. If you find yourself reading a file top to bottom twice, you are looking for something you should be searching for.',
    'method',
  ],
  [
    'What is the right size for a change?',
    'The smallest change that fully solves the stated problem and nothing else. Unrequested refactors hide bugs inside diffs nobody asked to review, and they make a revert impossible without losing the fix. When a bigger cleanup is genuinely needed, do the fix first, then propose the cleanup as its own step.',
    'method',
  ],
  [
    'How do you handle a request that is ambiguous?',
    'Pick the reading that satisfies the literal words, state the assumption in one sentence, and proceed. Ask only when two readings differ in a way that costs real work to undo — data model, public API, money, destructive operations. Most ambiguity disappears once you commit to the smallest useful version.',
    'method',
  ],
  [
    'What does "make it work, then make it right" mean in practice?',
    'Establish a correct, observable baseline first, even if it is slow or ugly, and prove it with a check. Then improve one property at a time — speed, structure, error handling — re-running the same check. Optimising before a baseline exists means you cannot tell improvement from drift.',
    'method',
  ],
  [
    'How do you avoid breaking things you cannot see?',
    'Search for every caller before changing a signature, and run the full check you have rather than the one test that made you feel good. Grep is cheap; a missed caller is a runtime crash in a path nobody tested.',
    'method',
  ],

  // ------------------------------------------------------------------ code
  [
    'How should errors be handled in application code?',
    'Catch what you can act on, and let the rest propagate. Every catch either recovers, adds context, or cleans up — a catch that logs and returns a default value turns a loud failure into a silent wrong answer. When you add context, keep the original error as the cause so the stack trace survives.',
    'code',
  ],
  [
    'What makes a function easy to test?',
    'One job, explicit inputs, no hidden reads of global state or the clock or the network. If a function needs six mocks, the seams are in the wrong place. Pure core logic plus thin adapters at the edges is the shape that stays testable.',
    'code',
  ],
  [
    'When is a comment worth writing?',
    'When it records something the code cannot: why this approach and not the obvious one, what invariant must hold, what breaks if you change it. Comments that restate the next line are noise, and stale comments are worse than none because they are believed.',
    'code',
  ],
  [
    'How do you name things?',
    'Name the concept, not the type or the layer. `elapsedMs` beats `time`; `retryDelayMs` beats `delay`. Length is fine when it removes a question. Consistency matters more than taste: if the codebase says `workspace`, do not introduce `project` for the same thing.',
    'code',
  ],
  [
    'What is wrong with returning null to signal failure?',
    'It erases the reason. The caller must then guess between "not found", "not allowed" and "failed", and every caller guesses differently. Return an explicit result — a discriminated union, an error, or a thrown exception — so the failure carries its cause.',
    'code',
  ],
  [
    'How do you handle configuration and secrets?',
    'Configuration comes from the environment, secrets never enter the repository, and the code fails loudly at startup when something required is missing. A default value for a secret is a security bug waiting for a production deploy: it silently runs with the wrong credential.',
    'code',
  ],
  [
    'What is the problem with a very long function?',
    'Not length by itself — hidden state. A long function is a bug when you cannot name what it does in one sentence, when it mixes I/O with decisions, or when the same locals serve three unrelated purposes. Split along the seams that already exist; do not split purely to hit a line count.',
    'code',
  ],
  [
    'How should async code handle partial failure?',
    'Decide explicitly: fail the whole operation, or collect per-item results. Use the pattern the caller can act on and make it visible in the return shape. `Promise.all` fails fast and loses the other results; `allSettled` keeps them. Silent per-item failure inside a loop is the worst of both, because nobody learns it happened.',
    'code',
  ],
  [
    'When do you introduce an abstraction?',
    'On the third repetition with the *same* reason to change, not the second time you see similar-looking code. Duplicated code is cheap to fix later; a wrong abstraction is expensive to remove because everything depends on it. Two similar functions are usually one concept plus a parameter, which is not an abstraction at all.',
    'code',
  ],
  [
    'How do you write a defensive file write?',
    'Write to a temporary path in the same directory, fsync, then rename over the target. Rename within one filesystem is atomic, so a crash leaves either the old file or the new one — never half of each. Also check the size before writing: a truncated write that overwrites good data is unrecoverable.',
    'code',
  ],
  [
    'What should a good error message contain?',
    'What failed, on what input, and what the reader should do next. Include the identifier or path, not the whole object. "Could not read src/config.js: ENOENT — the file does not exist" is actionable; "Error reading file" is not.',
    'code',
  ],

  // ---------------------------------------------------------------- testing
  [
    'What should a unit test assert?',
    'The behaviour you are willing to promise, expressed through the public surface. Assert the output and the observable effect, not the internal call sequence — tests that pin implementation detail fail on every refactor and teach the team to ignore red.',
    'testing',
  ],
  [
    'When is an integration test worth more than a unit test?',
    'When the risk lives in the seams: serialisation, database constraints, auth middleware, routing, filesystem behaviour. Unit tests with mocks cannot catch a mismatch between two correct halves. One honest integration test often replaces ten mocked ones.',
    'testing',
  ],
  [
    'How do you test a bug fix?',
    'Write the failing test first, watch it fail for the reason the bug describes, then fix. That ordering is the only proof the test exercises the bug rather than the fix. A test added after the fix, that has never been red, may be asserting nothing.',
    'testing',
  ],
  [
    'Are snapshot tests a good idea?',
    'For things a human reads in review and rarely changes — generated markup, formatted output, serialised protocol samples. Not for fast-moving UI internals, where every commit regenerates the snapshot and review approval becomes mechanical. A snapshot nobody reads is a test that cannot fail meaningfully.',
    'testing',
  ],
  [
    'How do you keep a test suite fast?',
    'Separate the fast loop from the slow one: pure logic tests run in milliseconds, and anything touching network, disk or a browser runs in a named suite. Keep the slow suite out of the inner loop but mandatory before shipping. A suite too slow to run is a suite nobody runs.',
    'testing',
  ],
  [
    'What is a flaky test and what do you do about it?',
    'A test whose result depends on something it does not control: time, ordering, parallelism, network. Quarantine it, find the uncontrolled dependency, and fix that. Retrying it automatically trains everyone to accept red, which costs more than the test was worth.',
    'testing',
  ],

  // -------------------------------------------------------------------- git
  [
    'What makes a good commit?',
    'One logical change, a message that says why, and a diff a reviewer can hold in their head. The subject line is the summary; the body explains the reasoning and the trade-off. "Fix bug" tells the future reader nothing at the exact moment they need it most.',
    'git',
  ],
  [
    'How do you find which commit introduced a bug?',
    'Bisect. Mark a known-good and a known-bad commit, halve, and let the history answer instead of your memory. It works best with a scripted check so each step is automatic and unambiguous. Guessing from commit messages is slower and wrong more often.',
    'git',
  ],
  [
    'When should you use git rebase instead of merge?',
    'Rebase to keep a private branch tidy before sharing it; merge to integrate shared history. Never rebase a branch someone else has pulled — you rewrite commits they already have, and their next pull becomes a conflict they did not cause.',
    'git',
  ],
  [
    'How do you review a large diff?',
    'In passes, not once. First the shape: what files, what is new, what is deleted, does the structure match the intent. Then behaviour, file by file, starting with the riskiest. Then the details: error paths, tests, naming. Reading a large diff linearly means the last third gets no attention.',
    'git',
  ],
  [
    'What should you never do to a shared repository without being asked?',
    'Force-push, rewrite published history, delete branches you did not create, or commit generated artefacts and secrets. Those are the operations that cannot be undone by the person who notices the damage.',
    'git',
  ],

  // --------------------------------------------------------------- security
  [
    'What is the most common serious security bug in web apps?',
    'Trusting client input on the server. The browser is the attacker\'s machine: every id, price, role and ownership flag it sends is a claim, not a fact. Authenticate the request, derive the user from the session, and check ownership in the query itself — never from a value the client supplied.',
    'security',
  ],
  [
    'How do you prevent SQL injection?',
    'Parameterised queries, always, including for identifiers via an allowlist. String concatenation is unsafe even when the value "looks numeric", because the check that made it look numeric is usually elsewhere and eventually removed.',
    'security',
  ],
  [
    'Where should API keys live?',
    'Server-side only: an environment variable or a secret store, read by the process that needs it. A key in client code, a bundle, a log line or a repository is public. If a key ever appears in a URL or a log, treat it as leaked and rotate it.',
    'security',
  ],
  [
    'What is the risk of a long-lived token in browser storage?',
    'Any script on the page can read it, so one XSS becomes full account takeover that survives a password change. Prefer an httpOnly, SameSite cookie for sessions, short expiry, and refresh rotation. Where storage is unavoidable, keep the lifetime short and the scope narrow.',
    'security',
  ],
  [
    'How do you check that a file path from a user is safe?',
    'Resolve it against the allowed root and verify the result is still inside that root after resolution — symlinks included. Rejecting ".." as a string is not enough: encodings, absolute paths and symlinks all get around it. Resolve first, compare after.',
    'security',
  ],
  [
    'What belongs in an authorization check?',
    'Who the user is (from the session), what the resource is (from the database), and whether this user may act on it (a rule the server owns). Every one of those three must be server-side. Client-side hiding of a button is a courtesy, never a control.',
    'security',
  ],

  // ------------------------------------------------------------ performance
  [
    'How do you make something faster?',
    'Measure first, and measure the thing the user feels. Optimising by intuition reliably improves the wrong code path. Get a baseline number, find the dominant cost, change one thing, re-measure the same way. No measurement, no claim.',
    'performance',
  ],
  [
    'What is usually the real cost in a slow page?',
    'Waterfall and payload, not CPU. Requests that wait on each other, images far larger than their slot, and JavaScript nobody on that screen needs. Fix the sequence and the bytes before micro-optimising functions.',
    'performance',
  ],
  [
    'When is caching the wrong answer?',
    'When you cannot state precisely what invalidates an entry. A cache without an invalidation rule is a slow-motion correctness bug: it serves stale data at the exact moment freshness matters most, and it does so intermittently, which is the hardest kind of bug to find.',
    'performance',
  ],
  [
    'How do you handle a large dataset in a UI?',
    'Do not render it. Paginate or virtualise so the DOM holds what is visible plus a small buffer, and keep the filtered slice in memory rather than the whole set. Measure the interaction, not the initial paint — the freeze users notice is usually on scroll or filter.',
    'performance',
  ],
  [
    'What is an N+1 query and why does it matter?',
    'One query for a list, then one per row: a hundred rows becomes a hundred and one round trips, and latency multiplies. Fix it by fetching the related set in one query and joining in memory. It is invisible in development with three rows and fatal in production with three thousand.',
    'performance',
  ],
  [
    'How do you decide whether to optimise at all?',
    'Ask what the user experiences and what the budget is. If the interaction is under the threshold where people notice, more speed buys nothing and costs readability. Optimisation is a trade against clarity, so it needs a reason with a number attached.',
    'performance',
  ],

  // ------------------------------------------------------------- architecture
  [
    'How do you choose between two libraries?',
    'By the constraint that actually binds: bundle size, maintenance activity, licence, how it fails, and whether it can be removed later. Popularity answers none of those. Check the issue tracker for the failure mode you would hit, and prefer the one whose abstractions you can escape.',
    'architecture',
  ],
  [
    'When should code be split into modules?',
    'When a boundary already exists in the domain: a thing with its own state, its own reason to change, and a small surface others use. Splitting by file type produces modules that change together and hide nothing. The test is whether you can describe the module without listing its contents.',
    'architecture',
  ],
  [
    'How do you keep a growing frontend maintainable?',
    'Keep state in one place per concern, keep components presentational where possible, and put I/O at the edges behind a small function. The failure mode is not file count — it is the same piece of state written from five places, at which point nobody can say what the current value means.',
    'architecture',
  ],
  [
    'What is the cost of an early abstraction?',
    'You commit to a shape before you understand the problem, then every new case bends around it. Interfaces invented from one example are almost always the wrong seams. Wait for the second or third real case; the right abstraction is usually smaller than the guessed one.',
    'architecture',
  ],
  [
    'How do you design an API others will call?',
    'Make the correct call the easy one, and make failure explicit. Stable names, one obvious way to do each thing, errors that carry a code and a message, and versioning you can honour. Every optional parameter is a decision the caller must make, so keep the surface small.',
    'architecture',
  ],
  [
    'What does "make it observable" mean for a service?',
    'When it misbehaves, you can answer "what happened to this request" without adding code. That means structured logs with a request id, a few real metrics (latency, error rate, queue depth), and errors that keep their cause. Logs that only say "error occurred" are decoration.',
    'architecture',
  ],

  // ------------------------------------------------------------------- agent
  [
    'You were asked to change behaviour but the code looks wrong elsewhere. What do you do?',
    'Do the requested change, and mention the other problem in one sentence without touching it. Unrequested fixes inside a requested diff make review and revert harder, and the user did not agree to the risk. Offer it as a follow-up instead.',
    'agent',
  ],
  [
    'How do you handle a file too large to rewrite in one go?',
    'Edit it in exact snippets at distinct anchors, one change per call, verifying the text you match against actually exists. Large files are normal; what fails is guessing at content you did not read. If an anchor is not found, read that region and match what is really there rather than retrying the same string.',
    'agent',
  ],
  [
    'What do you do when a command fails twice?',
    'Stop repeating it. Read the output for the actual cause, state a hypothesis in one sentence, then run a different action that tests it. Identical retries are how an agent burns a budget while looking busy. A different failure after a different attempt is progress; the same failure twice is a signal to change approach.',
    'agent',
  ],
  [
    'How do you report work you could not verify?',
    'Say what you ran, what it returned, and what you did not run. "Compiled but not clicked through", "tests pass, no browser check" — that is the honest form. Claiming a UI looks right without looking is the single fastest way to lose the user\'s trust, and it is always discovered.',
    'agent',
  ],
  [
    'What should you do before editing a file you have not read?',
    'Read it. Read the region you intend to change at minimum, and search for the callers of anything you alter. Editing from a filename and an assumption produces plausible code that does not fit, and the failure surfaces later as someone else\'s bug.',
    'agent',
  ],
  [
    'How do you choose which tool to use for a job?',
    'The narrowest one that answers the question: search to locate, read to understand, edit to change, run to verify. Reaching for a shell command to do something the editor already does loses structure and makes the change harder to review. One tool call that answers the question beats five that gesture at it.',
    'agent',
  ],
  [
    'What is the difference between a plan and progress?',
    'A plan is a list of intentions; progress is a tool result. Talking about what you are about to do is not doing it, and a long narration with no calls is the most common way an agent stalls. State the next step and take it in the same breath.',
    'agent',
  ],
  [
    'How do you behave when the user is frustrated and the last attempt failed?',
    'Find the actual cause instead of apologising twice. Name what failed, what you are changing as a result, and make one concrete move. Repeating the same approach with more enthusiasm is what makes a failure feel like a wall.',
    'agent',
  ],
]

function build() {
  const records = []
  for (const [question, answer, tag] of CORPUS) {
    records.push({
      messages: [
        { role: 'system', content: KNOWLEDGE_SYSTEM_PROMPT },
        { role: 'user', content: question },
        { role: 'assistant', content: answer },
      ],
      meta: { tag, source: 'javelin-knowledge-v1' },
    })
  }
  return records
}

/** Deterministic split by hash, so the same question always lands on the same side. */
function split(records, validationFraction = 0.15) {
  const train = []
  const validation = []
  for (const r of records) {
    let h = 0
    const s = r.messages[1].content
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
    if ((h % 1000) / 1000 < validationFraction) validation.push(r)
    else train.push(r)
  }
  return { train, validation }
}

const records = build()
const { train, validation } = split(records)
const outDir = join(root, 'datasets', 'knowledge')
mkdirSync(outDir, { recursive: true })

const toJsonl = (rs) => rs.map((r) => JSON.stringify(r)).join('\n') + '\n'
writeFileSync(join(outDir, 'train.jsonl'), toJsonl(train), 'utf8')
writeFileSync(join(outDir, 'validation.jsonl'), toJsonl(validation), 'utf8')

const tags = {}
for (const r of records) tags[r.meta.tag] = (tags[r.meta.tag] ?? 0) + 1

writeFileSync(
  join(outDir, 'manifest.json'),
  JSON.stringify(
    {
      format: 'chat-jsonl',
      version: '1.0.0',
      builtAt: new Date().toISOString(),
      total: records.length,
      trainCount: train.length,
      validationCount: validation.length,
      byTag: tags,
      systemPrompt: KNOWLEDGE_SYSTEM_PROMPT,
    },
    null,
    2,
  ),
  'utf8',
)

console.log(`\nKnowledge corpus: ${records.length} example(s)`)
console.log(`  train       ${train.length}`)
console.log(`  validation  ${validation.length}`)
console.log(`  by tag      ${JSON.stringify(tags)}`)
console.log(`\nwritten to ${outDir}\n`)

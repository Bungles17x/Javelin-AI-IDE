/**
 * Per-provider request queue.
 *
 * Some free endpoints allow exactly one request at a time per client. The app can
 * legitimately start several things at once — a chat reply, an Agent turn, a
 * Javelin run, or a chat title. Racing them produces a provider 429 even though
 * each piece is working correctly.
 *
 * Queue only the providers with a one-request rule. Providers with normal
 * concurrency keep running in parallel.
 */

const SINGLE_REQUEST_PROVIDERS = new Set([
  'javelincloud',
  'javelinclouddirect',
])

const queues = new Map()

function abortError() {
  const error = new Error('The request was stopped before it started.')
  error.name = 'AbortError'
  return error
}

/**
 * Run `task` after earlier requests for the same single-slot provider finish.
 *
 * A queued task checks its signal before sending anything. Errors from earlier
 * tasks are swallowed by the chain, so one failure never blocks the queue.
 *
 * @template T
 * @param {string} providerId
 * @param {() => Promise<T>} task
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
export function enqueueProviderRequest(providerId, task, signal) {
  if (signal?.aborted) return Promise.reject(abortError())

  if (!SINGLE_REQUEST_PROVIDERS.has(providerId)) {
    return Promise.resolve().then(task)
  }

  const previous = queues.get(providerId) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(() => {
    if (signal?.aborted) throw abortError()
    return task()
  })
  const tail = run.catch(() => {})
  queues.set(providerId, tail)

  // Do not retain a resolved tail forever. Compare identity so a newer request
  // that joined while this one was running is left in the map.
  tail.finally(() => {
    if (queues.get(providerId) === tail) queues.delete(providerId)
  })

  return run
}

export function providerHasSingleRequestSlot(providerId) {
  return SINGLE_REQUEST_PROVIDERS.has(providerId)
}

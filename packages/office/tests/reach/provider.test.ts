/** The model for learning: hq/provider.json, asked for with init's picker the first time, and a ChatGPT
 *  subscription's sign-in in hq/auth.json, refreshed or asked for again. */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { AuthError, AuthStore, OAuthCredentials } from "@ngocbh/yian/llm_clients"
import { Provider } from "../../src/chat/provider.ts"
import { HOW_SIGN_IN, providerSecrets, SUBSCRIPTION } from "../../src/install/onboard.ts"
import { OnboardError } from "../../src/install/prompts.ts"
import { ReachPaths } from "../../src/reach/paths.ts"
import { learnProvider } from "../../src/reach/provider.ts"
import { writePrivate } from "../../src/secrets.ts"
import { ACCESS_TOKEN, ACCOUNT, fakeSubscription, NO_LISTING, REFRESH_TOKEN, Script } from "../install/helpers.ts"
import { fakeHome, KEY, reachCtx, rejection, subscribed, SUBSCRIBED_LLM, tokens } from "./helpers.ts"

setDefaultTimeout(30_000)

test("learnProvider asks with the picker the first time and reuses the file after", async () => {
  const { dir, fake } = fakeHome()
  const { paths } = await reachCtx(dir, fake)
  const ask = new Script(["", KEY, "claude-opus-4-1"])
  const checked: unknown[] = []
  const options = { listers: NO_LISTING, checkModel: async (p: Provider) => {
    checked.push(p.llm_config)
    return null
  } }
  const first = await learnProvider(paths, ask, options)
  expect(ask.seen[0]).toBe(`Learning needs a model. Its connection is kept in ${paths.provider}, readable only by you.`)
  expect(first.llm_config).toEqual({ provider: "anthropic", api_key: KEY, model: "claude-opus-4-1" })
  expect(fs.statSync(paths.provider).mode & 0o777).toBe(0o600)
  const again = new Script([])
  expect((await learnProvider(paths, again, options)).llm_config).toEqual(first.llm_config)
  expect(again.seen).toEqual([])
  expect(checked).toHaveLength(1)
  fs.writeFileSync(paths.provider, "{nope", { mode: 0o600 })
  const error = await rejection(learnProvider(paths, new Script([]), options))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toBe(`${paths.provider}: not valid JSON; fix it, or delete it to set up the model again`)
})

test("learnProvider can sign in to a ChatGPT subscription, keeps it in hq/auth.json, and gives runs YIAN_AUTH_FILE", async () => {
  const { dir, fake } = fakeHome()
  const { paths } = await reachCtx(dir, fake)
  const { checked, options } = subscribed()
  // openai, the subscription, its first model.
  const ask = new Script(["openai", "", ""])
  const first = await learnProvider(paths, ask, options)
  expect(ask.seen.slice(0, 3)).toEqual([
    `Learning needs a model. Its connection is kept in ${paths.provider}, readable only by you.`,
    "Model provider",
    HOW_SIGN_IN,
  ])
  // Only the variable is added: the rest of the run's env is the worker's, as for a key.
  expect(first.env).toEqual({ YIAN_AUTH_FILE: paths.auth })
  expect(first.llm_config).toEqual(SUBSCRIBED_LLM)
  // Checked on the new sign-in while it waits beside hq/auth.json.
  const pending = path.join(paths.dir, "auth.new.json")
  expect(checked.map((p) => [p.llm_config, p.env])).toEqual([[SUBSCRIBED_LLM, { YIAN_AUTH_FILE: pending }]])
  expect(fs.existsSync(pending)).toBe(false)
  expect(JSON.parse(fs.readFileSync(paths.provider, "utf8"))).toEqual({ method: "subscription", llm_config: SUBSCRIBED_LLM })
  expect(fs.statSync(paths.auth).mode & 0o777).toBe(0o600)
  // What the learning run scrubs from what reaches the model and the terminal, and refuses to save.
  expect(providerSecrets(first)).toEqual([ACCESS_TOKEN, REFRESH_TOKEN, ACCOUNT])
  const again = new Script([])
  const second = await learnProvider(paths, again, options)
  expect(again.seen).toEqual([])
  expect([second.llm_config, second.env]).toEqual([SUBSCRIBED_LLM, { YIAN_AUTH_FILE: paths.auth }])
  expect(checked).toHaveLength(1)
})

test("a subscription's provider.json whose sign-in is missing or can't be read says so and asks again", async () => {
  const cases: [string, (paths: ReachPaths) => void, (paths: ReachPaths) => string][] = [
    ["missing", () => {}, (paths) => `its sign-in ${paths.auth} is missing`],
    [
      "open to others",
      (paths) => fs.writeFileSync(paths.auth, "{}", { mode: 0o644 }),
      (paths) => `its sign-in can't be read: Credential storage at ${paths.auth} must be private to its owner`,
    ],
    [
      "not a sign-in",
      (paths) => fs.writeFileSync(paths.auth, "{nope", { mode: 0o600 }),
      (paths) => `its sign-in can't be read: Credential storage at ${paths.auth}`,
    ],
  ]
  for (const [, damage, problem] of cases) {
    const { dir, fake } = fakeHome()
    const { paths } = await reachCtx(dir, fake)
    await writePrivate(paths.provider, JSON.stringify({ method: "subscription", llm_config: SUBSCRIBED_LLM }))
    damage(paths)
    const { checked, options } = subscribed()
    const ask = new Script(["openai", "", ""])
    const got = await learnProvider(paths, ask, options)
    expect(ask.seen[0]).toStartWith(`${paths.provider} signs in to a ChatGPT subscription, but ${problem(paths)}`)
    expect(ask.seen[0]).toEndWith("; set up the model again.")
    expect(ask.seen[1]).toBe("Model provider")
    expect(checked).toHaveLength(1)
    expect([got.llm_config, got.env]).toEqual([SUBSCRIBED_LLM, { YIAN_AUTH_FILE: paths.auth }])
    expect(new AuthStore(paths.auth).selection("openai")).toMatchObject({ method: "subscription" })
  }
  // With no one to ask, it says how to start over.
  const { dir, fake } = fakeHome()
  const { paths } = await reachCtx(dir, fake)
  await writePrivate(paths.provider, JSON.stringify({ method: "subscription", llm_config: SUBSCRIBED_LLM }))
  const error = await rejection(learnProvider(paths, new Script([], { interactive: false }), subscribed().options))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toBe(
    `${paths.provider} signs in to a ChatGPT subscription, but its sign-in ${paths.auth} is missing;` +
      " delete both and run `opencorp hq` again",
  )
})

test("a provider.json that sets YIAN_AUTH_FILE itself is refused", async () => {
  const { dir, fake } = fakeHome()
  const { paths } = await reachCtx(dir, fake)
  const other = path.join(dir, "other.json")
  await writePrivate(paths.provider, JSON.stringify({ llm_config: SUBSCRIBED_LLM, env: { YIAN_AUTH_FILE: other } }))
  const error = await rejection(learnProvider(paths, new Script([]), subscribed().options))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("YIAN_AUTH_FILE is set by the office")
})

/** A home whose hq/provider.json is a subscription on `model`, with a sign-in in hq/auth.json that expired. */
async function expiredHome(model = "gpt-5.5") {
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  await writePrivate(ctx.paths.provider, JSON.stringify({ method: "subscription", llm_config: { provider: "openai", model } }))
  await new AuthStore(ctx.paths.auth).save("openai", tokens("old", -60), model)
  return { dir, fake, ctx, paths: ctx.paths }
}

const REFUSED = new AuthError("OpenAI authentication request failed (HTTP 401, refresh_token_expired); sign in again", {
  status: 401,
})

test("learning removes a sign-in a stopped check left waiting beside hq/auth.json", async () => {
  const { paths } = await expiredHome()
  const pending = path.join(paths.dir, "auth.new.json")
  await new AuthStore(pending).save("openai", tokens("stray", 3600), "gpt-5.5")
  const subscription = fakeSubscription({ refreshed: tokens("new", 3600) })
  await learnProvider(paths, new Script([]), { listers: NO_LISTING, checkModel: async () => null, auth: subscription.auth })
  expect(fs.existsSync(pending)).toBe(false)
  expect(fs.existsSync(`${pending}.lock`)).toBe(false)
})

test("an expired sign-in that refreshes is used without asking, its new tokens saved", async () => {
  const { paths } = await expiredHome()
  const fresh = tokens("new", 3600)
  const subscription = fakeSubscription({ refreshed: fresh })
  const ask = new Script([])
  const got = await learnProvider(paths, ask, { listers: NO_LISTING, checkModel: async () => "unused", auth: subscription.auth })
  expect(ask.seen).toEqual([])
  expect(subscription.refreshes.count).toBe(1)
  expect(got.env).toEqual({ YIAN_AUTH_FILE: paths.auth })
  expect(new AuthStore(paths.auth).savedSecrets("openai")[0]).toBe(fresh.accessToken)
})

test("a sign-in OpenAI refuses to refresh says it expired and signs in again, the old answers the defaults", async () => {
  const { paths } = await expiredHome()
  const subscription = fakeSubscription({ refreshed: REFUSED })
  const checked: unknown[] = []
  // Enter at each question: openai, the subscription, then the model it had.
  const ask = new Script(["", "", ""])
  const got = await learnProvider(paths, ask, {
    listers: NO_LISTING,
    checkModel: async (p) => {
      checked.push(p.llm_config)
      return null
    },
    auth: subscription.auth,
  })
  expect(ask.seen[0]).toBe(
    `${paths.provider} signs in to a ChatGPT subscription, but its sign-in has expired or was revoked` +
      " (OpenAI authentication request failed (HTTP 401, refresh_token_expired)); sign in again.",
  )
  expect(ask.seen).toContain(HOW_SIGN_IN)
  expect(ask.offered.at(-1)).toContain("gpt-5.5")
  expect(checked).toEqual([{ provider: "openai", model: "gpt-5.5" }])
  expect([got.llm_config, got.env]).toEqual([{ provider: "openai", model: "gpt-5.5" }, { YIAN_AUTH_FILE: paths.auth }])
  expect(new AuthStore(paths.auth).savedSecrets("openai")[0]).toBe(ACCESS_TOKEN)
  for (const line of ask.seen) expect(line).not.toContain("yian auth")
  expect(SUBSCRIPTION).toBe("ChatGPT subscription")
})

test("a refresh that may work later stops learning, says to try again later, and keeps the sign-in", async () => {
  const cases: [AuthError, string][] = [
    [new AuthError("OpenAI authentication request failed (could not connect)"), "(could not connect)"],
    [new AuthError("OpenAI authentication request failed (HTTP 429)", { status: 429 }), "(HTTP 429)"],
    [new AuthError("OpenAI authentication request failed (HTTP 503)", { status: 503 }), "(HTTP 503)"],
    [
      new AuthError("OpenAI authentication request failed (HTTP 400, invalid_request)", { status: 400 }),
      "(HTTP 400, invalid_request)",
    ],
  ]
  for (const [refreshed, shown] of cases) {
    const { paths } = await expiredHome()
    const before = fs.readFileSync(paths.auth, "utf8")
    const ask = new Script([])
    const error = await rejection(
      learnProvider(paths, ask, { listers: NO_LISTING, checkModel: async () => null, auth: fakeSubscription({ refreshed }).auth }),
    )
    expect(error).toBeInstanceOf(OnboardError)
    expect(error.message).toBe(
      `OpenAI didn't refresh the ChatGPT sign-in in ${paths.auth}: OpenAI authentication request failed ${shown};` +
        " try again later",
    )
    expect(ask.seen).toEqual([])
    expect(fs.readFileSync(paths.auth, "utf8")).toBe(before)
  }
})

test("only an auth refusal of the refresh signs in again", async () => {
  const refusals = [
    new AuthError("OpenAI authentication request failed (HTTP 400, invalid_grant); sign in again", { status: 400 }),
    new AuthError("OpenAI authentication request failed (HTTP 401)", { status: 401 }),
    new AuthError("OpenAI authentication request failed (HTTP 403)", { status: 403 }),
  ]
  for (const refreshed of refusals) {
    const { paths } = await expiredHome()
    const ask = new Script(["", "", ""])
    await learnProvider(paths, ask, { listers: NO_LISTING, checkModel: async () => null, auth: fakeSubscription({ refreshed }).auth })
    expect(ask.seen[0]).toContain("its sign-in has expired or was revoked")
    expect(ask.seen[0]).toEndWith("; sign in again.")
  }
})

test("a refresh that comes back for another account says so and signs in again", async () => {
  const { paths } = await expiredHome()
  const other = new OAuthCredentials({
    accessToken: "other-access-0123456789",
    refreshToken: "other-refresh-0123456789",
    expiresAt: Date.now() / 1000 + 3600,
    accountId: "another-account-0123456789",
  })
  const ask = new Script(["", "", ""])
  const got = await learnProvider(paths, ask, {
    listers: NO_LISTING,
    checkModel: async () => null,
    auth: fakeSubscription({ refreshed: other }).auth,
  })
  expect(ask.seen[0]).toBe(
    `${paths.provider} signs in to a ChatGPT subscription, but its sign-in refreshed to another ChatGPT account` +
      " (Subscription refresh changed account identity); sign in again.",
  )
  expect(got.env).toEqual({ YIAN_AUTH_FILE: paths.auth })
  expect(new AuthStore(paths.auth).savedSecrets("openai")).toEqual([ACCESS_TOKEN, REFRESH_TOKEN, ACCOUNT])
})

test("a stop at any point of saving leaves provider.json beside its checked sign-in, or beside none, which asks again", async () => {
  const old = { method: "subscription", llm_config: { provider: "openai", model: "gpt-4.1" } }
  // Where a stop can leave things, in the order they're written: the old sign-in goes, then provider.json is written,
  // then the new sign-in moves in.
  const stops: [string, { provider: object; auth: boolean }, boolean][] = [
    ["during the check", { provider: old, auth: true }, false],
    ["once the old sign-in is gone", { provider: old, auth: false }, true],
    ["once provider.json is written", { provider: { ...old, llm_config: SUBSCRIBED_LLM }, auth: false }, true],
  ]
  for (const [, state, asks] of stops) {
    const { dir, fake } = fakeHome()
    const { paths } = await reachCtx(dir, fake)
    await writePrivate(paths.provider, JSON.stringify(state.provider))
    if (state.auth) await new AuthStore(paths.auth).save("openai", tokens("old", 3600), "gpt-4.1")
    await new AuthStore(path.join(paths.dir, "auth.new.json")).save("openai", tokens("new", 3600), "gpt-5.5-codex")
    const ask = new Script(["openai", "", ""])
    const checked: unknown[] = []
    await learnProvider(paths, ask, {
      listers: NO_LISTING,
      checkModel: async (p) => {
        checked.push(p.llm_config)
        return null
      },
      auth: fakeSubscription().auth,
    })
    expect(fs.existsSync(path.join(paths.dir, "auth.new.json"))).toBe(false)
    if (asks) {
      expect(ask.seen[0]).toBe(`${paths.provider} signs in to a ChatGPT subscription, but its sign-in ${paths.auth} is missing; set up the model again.`)
      expect(checked).toHaveLength(1)
    } else {
      // The old pair, checked when it was saved.
      expect(ask.seen).toEqual([])
      expect(new AuthStore(paths.auth).savedSecrets("openai")[0]).toBe("old-access-0123456789")
    }
  }
})

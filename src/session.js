import { AssumeError, shellEnvironment } from "./credentials.js";
import { isAllowedProfile, resolveAllowedProfiles } from "./policy.js";

export const NO_ACTIVE_PROFILE = "No AWS profile is active, so aws_bash did not run. Select an allowed profile with assume_profile first, or use plain bash if no assumed profile is needed.";

// Secrets live only in private fields. Public methods return metadata or a child-process env.
export class RoleSession {
  #profiles;
  #patterns;
  #autoApproveRules;
  #approved = new Set();
  #active;
  #credentials;
  #fetch;
  #region;
  #profileRegion;
  #now;
  #generation = 0;
  #revision = 0;
  #controller = new AbortController();
  #tail = Promise.resolve();

  // autoApproveRules: [{ pattern, autoApprove: boolean, source: "project" | "global" }]; rules without an explicit
  // boolean have no opinion and must be omitted.
  constructor({ profiles, autoApproveRules = [], availableProfiles = [], fetch, region, now = Date.now }) {
    this.#patterns = Object.freeze([...profiles]);
    this.#autoApproveRules = Object.freeze(autoApproveRules
      .filter((rule) => typeof rule.autoApprove === "boolean" && ["project", "global"].includes(rule.source))
      .map(({ pattern, autoApprove, source }) => Object.freeze({ pattern, autoApprove, source })));
    this.#profiles = resolveAllowedProfiles(this.#patterns, availableProfiles);
    this.#fetch = fetch;
    this.#region = region;
    this.#now = now;
  }

  status() {
    return { profiles: [...this.#profiles], profilePatterns: [...this.#patterns],
      autoApproveRules: this.#autoApproveRules.map((rule) => ({ ...rule })), approvedProfiles: [...this.#approved],
      activeProfile: this.#active ?? null,
      expiresAt: this.#credentials ? new Date(this.#credentials.expiresAt).toISOString() : null };
  }

  revision() { return this.#revision; }

  // Matching project rules that set autoApprove decide, with false winning among them.
  // Selected global rules apply only when no matching project rule sets it. Default: confirm.
  #autoApproves(profile) {
    for (const source of ["project", "global"]) {
      const matching = this.#autoApproveRules.filter((rule) => rule.source === source && isAllowedProfile(profile, [rule.pattern]));
      if (matching.length) return matching.every((rule) => rule.autoApprove);
    }
    return false;
  }

  // Cancel pending/queued work without dropping the previously active role or approvals.
  cancel() {
    this.#generation++;
    this.#controller.abort();
    this.#controller = new AbortController();
    return this.status();
  }

  // Synchronous invalidation stops in-flight authentication from restoring a cleared role.
  clear({ approvals = false } = {}) {
    this.#revision++;
    this.cancel();
    this.#active = undefined;
    this.#credentials = undefined;
    this.#profileRegion = undefined;
    if (approvals) this.#approved.clear();
    return this.status();
  }

  #run(operation, signal) {
    const generation = this.#generation;
    const combined = signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal;
    const check = () => {
      if (combined.aborted || generation !== this.#generation) throw new AssumeError("Role operation cancelled; no profile was activated.");
    };
    const result = this.#tail.then(async () => { check(); return operation({ signal: combined, check }); });
    this.#tail = result.catch(() => {});
    return result;
  }

  // onAutoApprove reports approvals granted by policy, so they are never silent.
  assume(profile, { userInitiated = false, confirm = async () => false, onAutoApprove = () => {}, signal } = {}) {
    return this.#run(async ({ signal: combined, check }) => {
      if (!isAllowedProfile(profile, this.#patterns)) throw new AssumeError("That concrete profile name does not match the project allowlist.");
      if (!this.#approved.has(profile)) {
        const automatic = !userInitiated && this.#autoApproves(profile);
        const approved = userInitiated || automatic || await confirm(profile, combined);
        check();
        if (!approved) throw new AssumeError("Profile approval declined; the active role is unchanged.");
        this.#approved.add(profile);
        if (automatic) {
          try { onAutoApprove(profile); } catch { /* A notice failure must not change role state. */ }
        }
      }
      if (this.#active === profile && this.#credentials.expiresAt > this.#now() + 300000) return this.status();
      const credentials = await this.#fetch(profile, { signal: combined });
      check();
      let profileRegion;
      try { profileRegion = this.#region?.(profile); } catch { profileRegion = undefined; }
      this.#credentials = credentials;
      this.#active = profile;
      this.#profileRegion = profileRegion;
      this.#revision++;
      return this.status();
    }, signal);
  }

  // Credentialed environment for the AWS shell tool. Without an active role it refuses rather
  // than falling back to ambient/default credentials.
  environment(base, { signal } = {}) {
    return this.#run(async ({ signal: combined, check }) => {
      if (!this.#active) throw new AssumeError(NO_ACTIVE_PROFILE);
      if (this.#credentials.expiresAt <= this.#now() + 300000) {
        const credentials = await this.#fetch(this.#active, { signal: combined });
        check();
        this.#credentials = credentials;
      }
      check();
      if (!this.#active) throw new AssumeError(NO_ACTIVE_PROFILE);
      return shellEnvironment(base, this.#credentials, this.#profileRegion);
    }, signal);
  }
}

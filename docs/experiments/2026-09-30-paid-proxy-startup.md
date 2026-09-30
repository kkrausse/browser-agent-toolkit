# Paid proxy startup candidate

The activated host owns the private Zen credential; the guest must not receive it.
The existing readiness code already selects the model from the loaded global
configuration, not the contributor-free descriptor fallback.

The unchanged retained server's `opencode.provider.opencode` plugin disables every
model with positive input cost when neither `OPENCODE_API_KEY`, an integration
connection, nor provider `settings.apiKey` exists (retained server lines
546613–546631). Host proxy authentication alone is not visible to that policy.

The proxy-only configuration now explicitly activates the provider and supplies
the public `editor-host-proxy` routing marker as its SDK key. This is not a real
credential: the host handler strips the guest authorization and installs its own
provider headers. Actual paid-model readiness still requires the configured model
to be present, enabled, and tool-capable; no readiness check was removed.

`stage-single-kernel-live.ts` accepts an optional browser source entrypoint to
stage separate candidate bytes while retaining the verified workspace/runtime
assets and current UI/CSS. The parent owns activation and browser verification.
No model requests or host restart were performed by this fix. This is not yet
evidence that a paid model call works.

Checks: six launch/config tests passed directly; three readiness tests passed
after bundling against the frozen qualified workspace library (the local package
link has no built diagnostics export). The readiness tests reject tool-less,
disabled, and missing configured models. Candidate UI staging completed without
rebuilding the runtime or writing into the live output.

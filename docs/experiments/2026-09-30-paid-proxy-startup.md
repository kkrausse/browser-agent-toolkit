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

## Actual browser rejected the first candidate

The parent activated `d208bea` and observed the same readiness rejection. The
proxy marker alone is insufficient; the first candidate did not fix startup.

Further reading of the exact retained artifact identifies the ordering:
`OpencodePlugin2` belongs to `ProviderPlugins2` in the `pre` list (547334,
550412), while `opencode.config.provider` (`Plugin30`) belongs to `post5`
(536999–537001, 550443). State transforms execute in insertion order
(82056, 82071–82073, 82132). Zen therefore disables the paid model before
the configuration supplies its proxy settings. The later config only updates
`model.enabled` when `config.disabled !== undefined` (537122–537123).
Omission preserves the earlier disabled state.

The supplied proxy catalog now explicitly emits `disabled: false`, preserving
any caller's explicit `disabled: true` and without mutating the supplied catalog.
The actual installed OpenCode 2.0.3 `ConfigProvider.Info` schema decodes both the
availability field and proxy marker; seven configuration tests pass. Executing
the exact retained availability fragment after SHA-256 verification confirms
that omission retains disabled state and the generated config restores enabled
state. This is a fragment check, not a complete guest startup proof.

On rejection the browser readiness check now emits bounded public facts in its
error and `opencode.readiness.model-rejected` event. It additionally reads the
real `/api/provider/opencode` and `/api/model/default` routes with the same
location query and authentication, at most three seconds each. Only selection,
availability booleans, marker equality, activation, and bounded model IDs leave
the function; raw settings and credentials never do. The model-list route serves
`catalog.model.available()`, not all models (555564–555566), so a disabled model
will appear as missing. Four readiness tests pass, including credential omission.

Parent must still activate and verify the corrected availability candidate. No
claim of successful paid startup or model calls follows from these checks.

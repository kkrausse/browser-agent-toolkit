# Fresh integrated Effect-loader acceptance: preflight stopped

**No acceptance attempt launched.** The explicitly authorized one fresh unchanged
full/focused cohort stopped during an additional preflight check, before creating
a run copy, host, browser session or guest. No retry or corrected-check launch was
performed. This is not a second `apps-1` failure or a successful acceptance result.

Absolute report:
`/Users/kkrausse/Documents/repos/kkrausse/browser-agent-toolkit-single-kernel/docs/experiments/2026-09-30-effect-loader-fresh-integrated-acceptance.md`.

## Concrete blocker

The new external preflight script mistakenly assumed that the full preparation's
`runtime-source` tree contains every reused native output, in addition to the
repaired owner and actual native source/destination trees. It stopped on its first
native-output read in that additional fourth root:

```text
ENOENT: no such file or directory, open
/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-full-app-UMORaL/runtime-source/packages/vfs/pkg/.gitignore
```

This is an observer/preflight assumption error, **not an artifact digest mismatch**
or evidence that the frozen runnable distribution is defective. Native runnable
archive and frozen native artifacts must not be confused with a source tree.
The assignment explicitly required stopping before launch if preparation assertions
failed; no correction/re-execution was used to bypass that checkpoint.

## Checks completed before the stop

The one preflight execution completed these sequential digest checks:

| Immutable input | Verified files |
| --- | ---: |
| URL-repaired candidate receipt | 107 |
| URL-repaired owner freeze | 1,020 |
| Full delivery freeze | 9,728 |
| Frozen full delivery receipt | 9,721 |
| Full delivery's original driver-source inventory | All receipt-listed sources |
| Native inputs and reused outputs in actual source, destination and repaired owner's source tree | 12 inputs / 37 outputs per root |
| Full preparation's source tree | 12 native inputs; output check stopped at missing `.gitignore` |

Native inputs/outputs were verified reuse, **not rebuilt**. Later reversal/consumer
graph assertions in the new script were **unrun**; the existing immutable reversal
proof was read but is not presented as a new independently completed check.

Unchanged admitted identities:

| Item | Identity |
| --- | --- |
| Runtime source | `3ee918522c1233a1f8e10a9b798c09b6c3e30c81` |
| Toolkit candidate source | `9814c715cfca42309c581440577976833f4326e6` |
| Effect | `4.0.0-rc.118`; chat rc.112 unchanged |
| Distribution | `bd39000ff5bbc334f836ad65a4433e627525070413f810d7169132102f49b9f9` |
| Frozen receipt | `42d8ba68c2f0c972c7c5bdabe82e5fc112c75af3005d39fcf77693219563ae2a` |
| Compiled core, covered by repaired freeze | `211dccea972c1302b5536aff844688bc3be9271538dde45c80de416d16886070` |
| Kernel worker, covered by frozen receipt | `c4193ae0cba8419149738ed2b3a74d79d5f59f5e447eff129106ca2f3532fecb` |
| SDK host, covered by frozen receipt | `14e5b1e965c4645ccbed41a93536db8b941b5ed076225dfea9288d9a0b5dfc87` |

These are verified file identities, **not served response hashes**. No browser
identity, live worker census, image, public error/header/body boundary, close
receipt, native listener or Web Lock census was captured: no live workload began.

## Denominators and ownership

- New full application: **0 attempts**, 0/19 stages, 0/5 generations; all unrun.
- New focused contracts: **0 attempts**, 0/10 cases, 0/14 steps; all unrun.
- Historical `4470897`: its one combined attempt remains **failed at `apps-1`**,
  with eleven foundation stages passed and focused acceptance unrun.
- Diagnostic `99748de`/readiness result remains diagnostic only, not full acceptance.
- Offline adapter `85e532e` remains 10/10 passed; prior real-loader browser cases
  remain 2/2 passed. Neither was rerun or promoted into integrated acceptance.

Only a new audit directory (with `preflight-failure.json`) and a new external
preflight script were created:

`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-loader-fresh-integrated-audit-20260930-713fc924`

`/private/var/folders/t_/x48jtnps7n5_0g_pt9xpvbg00000gn/T/opencode/effect-fresh-acceptance-preflight-20260930.ts`

The planned run/evidence paths were never created. No owned host PID, listener,
CLI session, CDP attachment, acceptance lock or guest requires retirement. The
exclusive visible-browser slot is **released unused**. No user tab, origin storage,
shared relay, source, pin, shared distribution, `.runtime`, historical evidence or
old frozen artifact was changed. No inference/model route or headless cohort ran.
The unrelated staged endpoint-owner report is preserved.

## Parent decision

Integrated phase1 review readiness is **not established by this assignment**.
The smallest next action is parent review of the incorrect extra native-root
assumption and an explicit decision whether to reauthorize the still-unrun finite
acceptance gate using the actual recorded native closure. This report does not
authorize that launch, another qualification loop, phase2, a production patch,
cache admission or full migration. Existing `markAsUncloneable`, editor failed-save/
retained-target, path-security and all-writer limitations remain unchanged.

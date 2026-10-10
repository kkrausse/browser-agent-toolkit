// Replaces packages/tui `#attention-sounds`: paths to bundled mp3 files that
// the native client plays through OpenTUI's audio engine. The wasm core has no
// audio (see NOTES.md), so these are labels only.
export const defaultSoundPath = "/wasm-term/audio/bip-bop-01.mp3"
export const questionSoundPath = "/wasm-term/audio/bip-bop-03.mp3"
export const permissionSoundPath = "/wasm-term/audio/staplebops-06.mp3"
export const errorSoundPath = "/wasm-term/audio/nope-03.mp3"
export const subagentDoneSoundPath = "/wasm-term/audio/yup-01.mp3"

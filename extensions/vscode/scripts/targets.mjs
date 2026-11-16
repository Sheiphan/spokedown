// Platform builds we publish: [VS Code target, process.platform, process.arch].
export const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"];

/** The target matching the machine this runs on (for CI smoke tests). */
export const nativeTarget = () => `${process.platform}-${process.arch}`;

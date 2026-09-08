import pc from "picocolors";

/**
 * The colour vocabulary DevFlow writes in, over picocolors.
 *
 * picocolors already decides once, at import, whether colour is wanted: it
 * honours NO_COLOR, FORCE_COLOR, `--no-color`, CI and a non-TTY stdout, and
 * every function degrades to the identity when the answer is no. So there is
 * no "should I colour this?" check anywhere else in the codebase — the
 * functions below are safe to call unconditionally, and piping the CLI into
 * a file or an agent's buffer produces clean text.
 *
 * `bold.underline` exists because chalk's chaining was used for section
 * headings; composing the two picocolors calls here keeps those call sites
 * unchanged rather than spreading `pc.bold(pc.underline(x))` around.
 */

type Paint = (text: string) => string;

const compose =
  (...paints: Paint[]): Paint =>
  text =>
    paints.reduceRight((acc, paint) => paint(acc), text);

export const colors = {
  bold: Object.assign(((text: string) => pc.bold(text)) as Paint, {
    underline: compose(pc.bold, pc.underline),
  }),
  dim: (text: string) => pc.dim(text),
  green: (text: string) => pc.green(text),
  yellow: (text: string) => pc.yellow(text),
  red: (text: string) => pc.red(text),
  cyan: (text: string) => pc.cyan(text),
  white: (text: string) => pc.white(text),
  gray: (text: string) => pc.gray(text),
};

/** Whether colour is actually being emitted, for the few layout decisions. */
export const colorEnabled = (): boolean => pc.isColorSupported;

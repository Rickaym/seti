import { AGENT_COLOR_PRESETS, type AgentColor } from '@seti/shared'

/** A random preset among those `inUse` holds least, so neighbouring agents rarely share one. */
export function pickAgentColor(inUse: readonly AgentColor[], random: () => number = Math.random): AgentColor {
  const uses = AGENT_COLOR_PRESETS.map(({ hex }) => ({ hex, count: inUse.filter((color) => color === hex).length }))
  const fewest = Math.min(...uses.map(({ count }) => count))
  const choices = uses.filter(({ count }) => count === fewest)
  return (choices.at(Math.floor(random() * choices.length)) ?? AGENT_COLOR_PRESETS[0]).hex
}

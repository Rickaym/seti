/** How a permission request names its tool: an MCP tool by server and tool, others by name. */
export function toolLabel(tool: string): string {
  const [prefix, server, ...rest] = tool.split('__')
  return prefix === 'mcp' && server !== undefined && rest.length > 0 ? `${server} ${rest.join('__')}` : tool
}

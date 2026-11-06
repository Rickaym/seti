type LeaveGuard = () => Promise<boolean>

const guards = new Set<LeaveGuard>()

export function addLeaveGuard(guard: LeaveGuard): () => void {
  guards.add(guard)
  return () => {
    guards.delete(guard)
  }
}

export async function mayLeave(): Promise<boolean> {
  for (const guard of guards) {
    if (!(await guard())) {
      return false
    }
  }
  return true
}

import { toast } from 'sonner'
import { apiPost, errorText, RequestError } from '@/api'

/** Terminals that may start a shell as they connect: new ones, or ones asked for a new shell. */
const fresh = new Set<string>()

/** Which terminals may start a shell, wherever they show: alone or in a layout. */
export const shellStarts = {
  allow: (id: string) => {
    fresh.add(id)
  },
  mayStart: (id: string) => fresh.has(id),
  /** The server started the shell, or the terminal closed; from now on it only reattaches. */
  done: (id: string) => {
    fresh.delete(id)
  },
}

/** Ends terminal `id`'s shell; a shell that already ended needs no stop. */
export async function stopShell(id: string): Promise<void> {
  shellStarts.done(id)
  try {
    await apiPost(`/terminals/${id}/stop`)
  } catch (e) {
    if (!(e instanceof RequestError && e.status === 404)) {
      toast.error(errorText(e))
    }
  }
}

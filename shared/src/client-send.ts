import { z } from 'zod'

/** The client's id for one send, the same on every retry, so a repeat takes effect once. */
export const clientSendId = z.uuid().optional()

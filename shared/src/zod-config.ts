import { z } from 'zod'

/** Seti's CSP forbids eval, which zod otherwise probes for with Function('') on its first parse. */
z.config({ jitless: true })

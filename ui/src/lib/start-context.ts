import { navigate } from '@/lib/route'

export function openStartPage(): void {
  navigate('agents', 'new')
}

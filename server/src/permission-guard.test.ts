import { describe, expect, it } from 'vitest'
import { guardCommand, type GuardScope } from './permission-guard.js'

const scope: GuardScope = {
  home: '/home/me',
  roots: ['/home/me/.seti/worktrees/web', '/home/me/work/notes'],
  protectedDirs: ['/home/me/.ssh', '/home/me/.aws', '/home/me/.config', '/home/me/.seti/credentials'],
  sandboxed: false,
}

const refused = (command: string, within: GuardScope = scope) => guardCommand(command, within) !== null
const sandboxed = { ...scope, sandboxed: true }

describe('the shell guard', () => {
  it('lets rm -r work inside the agent directories and the temporary directory', () => {
    expect(refused('rm -rf node_modules dist/')).toBe(false)
    expect(refused('rm -rf /home/me/.seti/worktrees/web/build')).toBe(false)
    expect(refused('rm -r /tmp/scratch-123')).toBe(false)
    expect(refused('cd /home/me/work/notes && rm -rf old')).toBe(false)
    expect(refused('rm -f ~/notes.txt')).toBe(false)
  })

  it('refuses rm -r outside them, on a whole root, or on a computed path', () => {
    expect(refused('rm -rf ~')).toBe(true)
    expect(refused('rm -rf ~/projects')).toBe(true)
    expect(refused('rm -Rf /home/me/.seti/worktrees/web')).toBe(true)
    expect(refused('rm -rf "$TARGET"')).toBe(true)
    expect(refused('rm -rf $(pwd)/x')).toBe(true)
    expect(refused('rm -rf ../other')).toBe(true)
    expect(refused('rm -rf .')).toBe(true)
    expect(refused('cd / && rm -rf usr')).toBe(true)
    expect(refused('ls && sudo rm --recursive /var/lib')).toBe(true)
    expect(refused('rm -rf /tmp')).toBe(true)
  })

  it('refuses rm a shell -c or eval wraps, as if it ran directly', () => {
    expect(refused("bash -c 'rm -rf ~'")).toBe(true)
    expect(refused('sh -c "cd / && rm -rf usr"')).toBe(true)
    expect(refused("eval 'rm -rf ~/projects'")).toBe(true)
    expect(refused("bash -lc 'rm -rf ~'")).toBe(true)
    expect(refused("bash -lc 'rm -rf build'")).toBe(false)
  })

  it('refuses xargs rm, whose targets no one sees', () => {
    expect(refused('find . -name "*.log" | xargs rm')).toBe(true)
    expect(refused('ls | xargs rm -rf')).toBe(true)
  })

  it('refuses a forced clean of untracked files', () => {
    expect(refused('git clean -fdx')).toBe(true)
    expect(refused('git clean -f')).toBe(true)
    expect(refused('git clean -n')).toBe(false)
  })

  it('refuses --output outside the agent directories, such as a shell startup file', () => {
    expect(refused("git log -1 --pretty=tformat:'echo pwned' --output=/home/me/.bashrc")).toBe(true)
    expect(refused('git show HEAD --output /home/me/.claude/settings.json')).toBe(true)
    expect(refused('git log -1 --output=$HOME/x')).toBe(true)
    expect(refused('git log -1 --output=/tmp/log.txt')).toBe(false)
    expect(refused('curl -s https://example.com --output build/page.html')).toBe(false)
  })

  it('refuses commands that run other programs through a flag, outside the sandbox only', () => {
    for (const command of [
      'rg --pre sh x evil.sh',
      'rg --pre=./evil.sh x',
      'rg --pre-glob "*" --pre sh x',
      'find . -name x -exec sh {} \\;',
      'find / -execdir rm {} +',
      'find . -delete',
      'gh pr view 1 --web',
      'GH_BROWSER=./evil.sh gh pr view 1',
    ]) {
      expect(refused(command), command).toBe(true)
      expect(refused(command, sandboxed), command).toBe(false)
    }
    expect(refused('rg needle src')).toBe(false)
    expect(refused('find . -name "*.ts"')).toBe(false)
  })

  it('refuses killing processes by name', () => {
    expect(refused('pkill -f vite')).toBe(true)
    expect(refused('ps aux | grep x; killall node')).toBe(true)
    expect(refused('kill 1234')).toBe(false)
    expect(refused('echo pkillers')).toBe(false)
    expect(refused('gh pr create --body "stop using pkill in scripts"')).toBe(false)
    expect(refused("bash -c 'pkill node'")).toBe(true)
  })

  it('refuses shell writes under credential folders and lets reads through', () => {
    expect(refused('echo key >> ~/.ssh/authorized_keys')).toBe(true)
    expect(refused('cp creds $HOME/.aws/credentials')).toBe(true)
    expect(refused('mkdir -p /home/me/.config/gh')).toBe(true)
    expect(refused('tee /home/me/.seti/credentials/token < x')).toBe(true)
    expect(refused('ls ~/.ssh')).toBe(false)
    expect(refused('echo hi > notes.txt')).toBe(false)
  })

  it('lets commands read credential folders while their output goes elsewhere', () => {
    expect(refused('ssh -F ~/.ssh/config host uptime 2>/dev/null')).toBe(false)
    expect(refused('cat ~/.ssh/known_hosts 2>/dev/null')).toBe(false)
    expect(refused('ssh -F ~/.ssh/config host uptime 2>&1 | tail -5')).toBe(false)
    expect(refused('ssh -i ~/.ssh/id_ed25519 host "df -h > /tmp/df.txt" >/dev/null 2>&1')).toBe(false)
    expect(refused('grep -c Host ~/.ssh/config > /tmp/hosts.txt')).toBe(false)
    expect(refused('ssh -F ~/.ssh/config host "sudo mkdir -p /srv/app && touch /srv/app/ready"')).toBe(false)
    expect(refused('aws s3 ls --profile prod 2>/dev/null; cat ~/.aws/config >&2')).toBe(false)
    expect(refused('cat "$HOME/.ssh/config" &>/tmp/out.log')).toBe(false)
    expect(refused("echo 'see ~/.ssh/config > notes' > notes.txt")).toBe(false)
  })

  it('refuses redirections and writing commands that land in a credential folder', () => {
    expect(refused('echo key > ~/.ssh/authorized_keys')).toBe(true)
    expect(refused('ssh-keyscan host >> ~/.ssh/known_hosts 2>/dev/null')).toBe(true)
    expect(refused('ssh-keyscan host 2>/dev/null >>~/.ssh/known_hosts')).toBe(true)
    expect(refused('echo x >| /home/me/.aws/credentials')).toBe(true)
    expect(refused('make 1>&2 &> ~/.config/gh/hosts.yml')).toBe(true)
    expect(refused('echo x >& ~/.ssh/log')).toBe(true)
    expect(refused('echo x > "$HOME/.ssh/config"')).toBe(true)
    expect(refused("echo x > '/home/me/.ssh/config'")).toBe(true)
    expect(refused('echo x > ${HOME}/.ssh/config')).toBe(true)
    expect(refused('echo x > ~/work/../.ssh/config')).toBe(true)
    expect(refused('cd ~/.ssh && echo x > config')).toBe(true)
    expect(refused('cd ~/.ssh && cat config 2>/dev/null')).toBe(false)
    expect(refused('cat key.pub | tee -a ~/.ssh/authorized_keys > /dev/null')).toBe(true)
    expect(refused('cp id.pub ~/.ssh/')).toBe(true)
    expect(refused('mv ~/.ssh/config /tmp/config')).toBe(true)
    expect(refused('rm ~/.ssh/known_hosts.old')).toBe(true)
    expect(refused('chmod 600 ~/.ssh/id_ed25519')).toBe(true)
    expect(refused('sudo chown me /home/me/.ssh')).toBe(true)
    expect(refused('dd if=/dev/zero of=~/.ssh/key bs=1 count=1')).toBe(true)
    expect(refused('install --target-directory=$HOME/.aws creds')).toBe(true)
    expect(refused("sed -i 's/a/b/' ~/.ssh/config")).toBe(true)
    expect(refused('ls ~/.ssh | xargs chmod 600')).toBe(true)
    expect(refused('if true; then cp a ~/.ssh/b; fi')).toBe(true)
    expect(refused('echo "$(cat key > ~/.ssh/id)"')).toBe(true)
    expect(refused('echo "`tee ~/.ssh/id < key`"')).toBe(true)
  })

  it('checks the scripts a shell -c or eval runs for credential writes too', () => {
    expect(refused("bash -c 'echo key >> ~/.ssh/authorized_keys'")).toBe(true)
    expect(refused('sh -c "cp id.pub ~/.ssh/authorized_keys"')).toBe(true)
    expect(refused("eval 'cat key > ~/.aws/credentials'")).toBe(true)
    expect(refused('bash -lc "eval \'chmod 600 ~/.ssh/id\'"')).toBe(true)
    expect(refused("bash -c 'cat ~/.ssh/config 2>/dev/null'")).toBe(false)
    expect(refused("eval 'ssh -F ~/.ssh/config host uptime 2>/dev/null'")).toBe(false)
  })

  it('says why it refused', () => {
    expect(guardCommand('rm -rf ~/projects', scope)).toContain('outside the agent')
    expect(guardCommand('pkill node', scope)).toContain('by name')
    expect(guardCommand('touch ~/.aws/config', scope)).toContain('/home/me/.aws')
    expect(guardCommand('rg --pre sh x f', scope)).toContain('--pre')
  })
})

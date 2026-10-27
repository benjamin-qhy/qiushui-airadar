import { homedir } from 'node:os'
import path from 'node:path'

export const applicationDirectoryName = '.qiushui-airadar'

export function applicationRoot(home = homedir()): string {
  return path.join(home, applicationDirectoryName)
}

export function developmentDataRoot(home = homedir()): string {
  return path.join(applicationRoot(home), 'development-data')
}

export function productionDataRoot(home = homedir()): string {
  return path.join(applicationRoot(home), 'production-data')
}

export function programRoot(home = homedir()): string {
  return path.join(applicationRoot(home), 'program')
}

export function serviceRoot(home = homedir()): string {
  return path.join(applicationRoot(home), 'service')
}

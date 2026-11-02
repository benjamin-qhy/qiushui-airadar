import { navigate, useBrowserUrl } from './navigation'

// Secondary tabs remain query parameters and share the same history as pages.
export function useUrlChoice<T extends string>(
  parameter: string,
  choices: readonly T[],
  fallback: T
): [T, (value: string) => void] {
  const url = useBrowserUrl()
  const value =
    choices.find((choice) => choice === url.searchParams.get(parameter)) ??
    fallback
  return [
    value,
    (next) => {
      const selected = choices.find((choice) => choice === next)
      if (selected === undefined) return
      const target = new URL(window.location.href)
      if (selected === fallback) target.searchParams.delete(parameter)
      else target.searchParams.set(parameter, selected)
      navigate(target)
    },
  ]
}

/** @jsxImportSource @opentui/solid */
import { createContext, type ParentProps, useContext } from "solid-js"

interface ContextProps { [key: string]: unknown }
export function createSimpleContext<T, Props extends ContextProps>(input: {
  name: string
  init: ((input: Props) => T) | (() => T)
}) {
  const ctx = createContext<T>()

  return {
    provider: (props: ParentProps<Props>) => {
      const init = input.init(props)
      return <ctx.Provider value={init}>{props.children}</ctx.Provider>
    },
    use() {
      const value = useContext(ctx)
      if (!value) throw new Error(`${input.name} context must be used within a context provider`)
      return value
    },
  }
}

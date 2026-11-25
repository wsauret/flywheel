import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createWorkspaceNavigation } from "./workspace-navigation.js"

test("workspace destinations dock only with room and other sheets remain modal over the panel", () => {
  createRoot(dispose => {
    try {
      const [canDock, setCanDock] = createSignal(true)
      const navigation = createWorkspaceNavigation(canDock)
      navigation.open("changes")
      expect(navigation.panel()).toBe("changes")
      expect(navigation.sheet()).toBeUndefined()
      navigation.open("background")
      expect(navigation.panel()).toBe("background")
      navigation.open("status")
      expect(navigation.panel()).toBe("status")
      navigation.open("settings")
      expect(navigation.sheet()).toBe("settings")
      expect(navigation.panel()).toBe("status")
      navigation.closeSheet()
      expect(navigation.sheet()).toBeUndefined()
      expect(navigation.panel()).toBe("status")
      // Selecting a session closes sheets; the docked panel is not one.
      navigation.closeSheet()
      expect(navigation.panel()).toBe("status")
      navigation.open("settings")
      navigation.clearModal()
      expect(navigation.sheet()).toBeUndefined()
      expect(navigation.panel()).toBe("status")
      setCanDock(false)
      expect(navigation.panel()).toBeUndefined()
      expect(navigation.sheet()).toBe("status")
      navigation.closeSheet()
      expect(navigation.sheet()).toBeUndefined()
      navigation.open("changes")
      expect(navigation.sheet()).toBe("changes")
      expect(navigation.panel()).toBeUndefined()
      setCanDock(true)
      expect(navigation.panel()).toBe("changes")
      expect(navigation.sheet()).toBeUndefined()
      navigation.closePanel()
      expect(navigation.panel()).toBeUndefined()
      // Without room to dock, another sheet replaces a workspace sheet, and
      // closing it does not bring the workspace sheet back.
      setCanDock(false)
      navigation.open("changes")
      navigation.open("settings")
      expect(navigation.sheet()).toBe("settings")
      navigation.closeSheet()
      expect(navigation.sheet()).toBeUndefined()
    } finally { dispose() }
  })
})

import { mountSemanticComponent, type SemanticPublication } from "../../app/semantic-rows-fixture.js"
import { NotificationsSheet } from "./sheet.js"

/** Mounts notifications under immutable client publications; the runtime accepts every dismissal. */
export function mountSemanticRows(_kind: "notifications", initial: SemanticPublication) {
  return mountSemanticComponent(NotificationsSheet, initial, { mutations: { "project_notifications.dismiss": () => ({ ok: true }) } })
}

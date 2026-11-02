import type { UserMessageImage } from "@infra/output-blocks"
import { createContext, useContext, type Accessor } from "solid-js"

interface AttachmentImagePresentation {
  readonly visible: Accessor<boolean>
  readonly open?: (image: UserMessageImage, label: string) => void
}

const AttachmentImages = createContext<AttachmentImagePresentation>({ visible: () => true })
export const AttachmentImagesProvider = AttachmentImages.Provider
const ImageClipBottom = createContext<Accessor<number | undefined>>(() => undefined)
export const ImageClipBottomProvider = ImageClipBottom.Provider

/** The main transcript clips images above its overlaid queue dock. */
export function useImageClipBottom(): Accessor<number | undefined> {
  return useContext(ImageClipBottom)
}

/** Images outside an overlay shell render as foreground, without a viewer action. */
export function useAttachmentImages(): AttachmentImagePresentation {
  return useContext(AttachmentImages)
}

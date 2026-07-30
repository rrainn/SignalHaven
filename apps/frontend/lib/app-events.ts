/**
 * Requests an authoritative guide reload after another screen changes the
 * channel or EPG data that may already be cached by the mounted Guide page.
 */
export const GUIDE_INVALIDATE_EVENT = "signalhaven:guide-invalidate";

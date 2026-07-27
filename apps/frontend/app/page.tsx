import { redirect } from "next/navigation";

/**
 * The Guide is SignalHaven's primary destination until a dedicated dashboard exists.
 * A server redirect prevents the retired scaffold from flashing on first load.
 */
export default function HomePage(): never {
	redirect("/guide");
}

import type { User, UserPreferences } from "@signalhaven/shared";

/** Serializable account state resolved before the client application hydrates. */
export type AuthBootstrap =
	| { status: "account-required"; systemSetupRequired: boolean }
	| { status: "signed-out" }
	| {
			status: "signed-in";
			user: User;
			preferences:
				| { status: "ready"; preferences: UserPreferences }
				| { status: "error"; message: string };
	  }
	| { status: "unavailable"; message: string };

import styles from './PersonaBadge.module.css';

/**
 * The "AI" label on an account that is a persona.
 *
 * Its own module, tiny and dependency-free, because of where it has to appear:
 * the public blog post page and the comment thread both render it, and neither
 * should pull the admin Personas panel — its form, its service layer, its
 * mutations — into their bundle to get one span. It started inside PersonasPanel
 * and was moved out for exactly that reason.
 *
 * **This is the disclosure.** Not the prompt telling the model not to claim to
 * be human — that is a second layer and it depends on the model cooperating.
 * This badge is rendered from `User.isPersona`, which the server sets on every
 * public shape of a user, so it does not depend on anything at generation time
 * having gone right. Anywhere an author's name is shown, this belongs next to it.
 */
export default function PersonaBadge({ className = '' }: { className?: string }) {
  return (
    <span
      className={`${styles.badge} ${className}`}
      // "AI" is two characters and carries no meaning read aloud, so the
      // accessible name says the whole thing and the tooltip explains it for
      // anyone who hovers.
      title="This account is an AI persona run by this site's operator"
      aria-label="AI persona"
    >
      AI
    </span>
  );
}

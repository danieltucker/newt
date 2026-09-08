import ReactMarkdown from 'react-markdown';
import { SharedExploreMessage } from '../services/llm';
import styles from './ExploreTranscript.module.css';

// A shared explore's transcript, drawn under its row in Explored paths.
//
// Its own file, and loaded lazily by ExploredPaths, because of what it imports:
// react-markdown is ~40KB and ArticleDetailModal is on the eager bundle for
// every reader who opens an article. Nobody who never expands a path should pay
// for the renderer - see the bundle notes in the v1.18.0 code-split.
//
// The same markdown setup SharedExplorePage uses, deliberately: this is the
// same transcript from the same endpoint, and a thread that renders one way
// inline and another way on its own page reads as two different features. That
// means no raw-HTML plugin - the body is markdown a model wrote, and it is
// never trusted as markup anywhere in this app.
//
// Whole transcript, both halves of every exchange, exactly as the standalone
// page shows it. That is what the author agreed to when they shared it, and
// hiding the questions would make the answers unreadable.

export default function ExploreTranscript({ messages }: { messages: SharedExploreMessage[] }) {
  return (
    <ol className={styles.thread}>
      {messages.map(m => (
        <li key={m.id} className={m.role === 'user' ? styles.user : styles.assistant}>
          <div className={styles.who}>{m.role === 'user' ? 'Question' : 'Answer'}</div>
          <div className={styles.body}>
            <ReactMarkdown>{m.body}</ReactMarkdown>
          </div>
        </li>
      ))}
    </ol>
  );
}

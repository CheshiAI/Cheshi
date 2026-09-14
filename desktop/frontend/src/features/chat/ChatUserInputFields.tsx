import { useId, useRef } from 'react';
import { ChevronRight, PenLine } from 'lucide-react';
import { NeumorphicTextField, SearchClearButton } from '../../shared/ui';
import type { ChatInputField, ChatInputQuestion } from '../../../../shared/chat-user-input';
import type { InputDraft } from './chatUserInputForm';
import styles from './ChatUserInputPrompt.module.css';

type DraftProps = { draft: InputDraft; onChange: (name: string, value: string | string[]) => void };

function QuestionAnswerField({ question, value, onChange, compact = false }: {
  question: ChatInputQuestion; value: string; onChange: DraftProps['onChange']; compact?: boolean;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const collapsible = compact && Boolean(question.options?.length);
  const field = <div className={styles.field}>
    {!collapsible && <label htmlFor={id}>{question.options?.length ? 'Your own answer' : 'Your answer'}</label>}
    <NeumorphicTextField id={id} ref={inputRef} type={question.isSecret ? 'password' : 'text'} value={value}
      aria-label={collapsible ? `Your own answer: ${question.question}` : undefined}
      placeholder={compact ? 'Type your answer…' : undefined}
      autoComplete="off" required={!question.options?.length}
      onChange={(event) => onChange(question.id, event.target.value)}
      trailingAction={value.length > 0 && <SearchClearButton aria-label={`Clear ${question.header} answer`}
        onClick={() => { onChange(question.id, ''); inputRef.current?.focus(); }} />} />
  </div>;
  return collapsible ? <details className={styles.customAnswer}>
    <summary><PenLine aria-hidden="true" /><span>Your own answer</span><ChevronRight aria-hidden="true" /></summary>
    {field}
  </details> : field;
}

export function ChatQuestionFields({ questions, draft, onChange, compact = false }: DraftProps & { questions: ChatInputQuestion[]; compact?: boolean }) {
  const id = useId();
  return <>{questions.map((question, index) => {
    const value = typeof draft[question.id] === 'string' ? draft[question.id] as string : '';
    const selected = question.options?.some((option) => option.label === value);
    return <fieldset key={question.id} className={styles.question}>
      {question.header && <legend>{question.header}</legend>}
      <p>{question.question}</p>
      {question.options?.map((option) => <label className={styles.option} key={option.label}>
        <input type="radio" name={`${id}-${index}`} checked={value === option.label} onChange={() => onChange(question.id, option.label)} />
        <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
      </label>)}
      {(!question.options?.length || question.isOther) && <QuestionAnswerField
        question={question} value={selected ? '' : value} onChange={onChange} compact={compact} />}
    </fieldset>;
  })}</>;
}

export function ChatMcpFields({ fields, draft, onChange }: DraftProps & { fields: ChatInputField[] }) {
  return <>{fields.map((field) => {
    const value = draft[field.name];
    const text = typeof value === 'string' ? value : '';
    if (field.type === 'array') return <fieldset key={field.name} className={styles.question}>
      <legend>{field.title}{field.required ? ' *' : ''}</legend>
      {field.description && <p>{field.description}</p>}
      {field.options?.map((option) => <label key={option.value} className={styles.option}>
        <input type="checkbox" checked={Array.isArray(value) && value.includes(option.value)} onChange={(event) => {
          const current = Array.isArray(value) ? value : [];
          onChange(field.name, event.target.checked ? [...current, option.value] : current.filter((item) => item !== option.value));
        }} /><span>{option.label}</span>
      </label>)}
    </fieldset>;
    return <label key={field.name} className={styles.field}>
      <span>{field.title}{field.required ? ' *' : ''}</span>
      {field.description && <small>{field.description}</small>}
      {field.type === 'boolean' || field.options ? <select value={text} required={field.required}
        onChange={(event) => onChange(field.name, event.target.value)}>
        <option value="">Choose an option</option>
        {field.type === 'boolean' ? <><option value="true">Yes</option><option value="false">No</option></>
          : field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select> : <input
        type={field.type === 'number' || field.type === 'integer' ? 'number' : field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : field.format === 'date' ? 'date' : 'text'}
        step={field.type === 'integer' ? 1 : 'any'} min={field.minimum} max={field.maximum}
        minLength={field.minLength} maxLength={field.maxLength} required={field.required} value={text}
        onChange={(event) => onChange(field.name, event.target.value)} />}
    </label>;
  })}</>;
}

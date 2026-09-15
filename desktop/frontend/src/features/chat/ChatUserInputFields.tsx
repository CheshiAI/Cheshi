import { useRef } from 'react';
import { NeumorphicButton, NeumorphicTextField, SearchClearButton } from '../../shared/ui';
import { useHelpLanguage } from '../../shared/useHelpLanguage';
import type { ChatInputField, ChatInputQuestion } from '../../../../shared/chat-user-input';
import type { InputDraft } from './chatUserInputForm';
import styles from './ChatUserInputPrompt.module.css';

type DraftProps = { draft: InputDraft; onChange: (name: string, value: string | string[]) => void };

function QuestionAnswerField({ question, value, selected, onChange }: {
  question: ChatInputQuestion; value: string; selected: boolean; onChange: DraftProps['onChange'];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [language] = useHelpLanguage();
  const label = language === 'ko' ? '직접 답변 또는 추가 설명' : 'Your own answer or additional details';
  const trailingAction = value.length > 0 && <SearchClearButton aria-label={`Clear ${question.header} answer`}
    onClick={() => { onChange(question.id, ''); (question.isSecret ? inputRef.current : textareaRef.current)?.focus(); }} />;
  return <div className={styles.field}>
    {question.isSecret ? <NeumorphicTextField aria-label={label} ref={inputRef} type="password" value={value}
      autoComplete="off" required={!selected} placeholder={label}
      onChange={event => onChange(question.id, event.target.value)} trailingAction={trailingAction} />
      : <NeumorphicTextField aria-label={label} className={styles.answerInput} ref={textareaRef} multiline rows={1} value={value}
        autoComplete="off" required={!selected} placeholder={label}
        onChange={event => onChange(question.id, event.target.value)} trailingAction={trailingAction} />}
  </div>;
}

export function ChatQuestionFields({ questions, draft, onChange, notes = {}, onNotesChange }: DraftProps & {
  questions: ChatInputQuestion[]; notes?: InputDraft; onNotesChange?: DraftProps['onChange'];
}) {
  return <>{questions.map((question) => {
    const value = typeof draft[question.id] === 'string' ? draft[question.id] as string : '';
    const selected = question.options?.some((option) => option.label === value) === true;
    const ownAnswer = onNotesChange ? notes[question.id] : selected ? '' : value;
    return <fieldset key={question.id} className={styles.question}>
      <legend>{question.question}</legend>
      <div className={styles.choices}>
        {question.options?.map((option, index) => <NeumorphicButton size="standard" className={styles.choice} key={option.label}
          aria-pressed={value === option.label} onClick={() => onChange(question.id, value === option.label ? '' : option.label)}>
          <span className={styles.number} aria-hidden="true">{index + 1}</span>
          <span className={styles.choiceText}><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
        </NeumorphicButton>)}
      </div>
      <QuestionAnswerField question={question} selected={selected} value={typeof ownAnswer === 'string' ? ownAnswer : ''}
        onChange={onNotesChange ?? onChange} />
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

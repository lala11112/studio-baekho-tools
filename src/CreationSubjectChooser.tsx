import { useEffect, useState } from 'react';
import { creationSubjectGroups, creationSubjects, type CreationSubjectGroup } from '../shared/graphics-creation';
import './creation-subject-chooser.css';

/** Draft selection only: category navigation never chooses a target or starts production. */
export function CreationSubjectChooser({ value, disabled = false, onChange, label = '무엇을 만들까요?' }: {
  value?: string;
  disabled?: boolean;
  onChange: (subjectId: string) => void;
  label?: string;
}) {
  const selected = creationSubjects.find(subject => subject.id === value);
  const [group, setGroup] = useState<CreationSubjectGroup>(selected?.group ?? 'living');
  useEffect(() => { if (selected) setGroup(selected.group); }, [value]);
  const description = creationSubjectGroups.find(item => item.id === group)!.description;
  return <fieldset className="gs-subject-chooser" disabled={disabled} data-testid="creation-subject-chooser">
    <legend>{label}</legend>
    <div className="gs-subject-groups" role="group" aria-label="오브젝트 분류">
      {creationSubjectGroups.map(item => <button type="button" key={item.id}
        aria-pressed={group === item.id} onClick={() => setGroup(item.id)}>{item.label}</button>)}
    </div>
    <div className="gs-subject-targets" role="group" aria-label="만들 대상 선택">
      {creationSubjects.filter(subject => subject.group === group && (!subject.legacy || subject.id === value)).map(subject =>
        <button type="button" key={subject.id} aria-pressed={value === subject.id}
          onClick={() => onChange(value === subject.id ? '' : subject.id)}>{subject.label}</button>)}
    </div>
    <p className="gs-subject-description">{description}</p>
    <p className="gs-subject-current" aria-live="polite">{selected ? `선택: ${selected.label}` : '만들 대상을 선택하세요.'}</p>
  </fieldset>;
}

import { useEffect, useState } from 'react';
import { Box, Building2, Check, Swords, Trees, Users } from 'lucide-react';
import { creationSubjectGroups, creationSubjects, type CreationSubjectGroup } from '../shared/graphics-creation';
import './creation-subject-chooser.css';

/** Draft selection only: category navigation never chooses a target or starts production. */
const groupIcons = { living: Users, objects: Box, equipment: Swords, architecture: Building2, nature: Trees };
const cardDescriptions = { living: '인간형 캐릭터, 동물, 크리처', objects: '가구, 생활용품, 도구, 기계', equipment: '검, 총, 의상, 방어구', architecture: '건물, 벽, 문, 계단', nature: '바위, 나무, 풀, 지형 조각' };
export function CreationSubjectChooser({ value, disabled = false, onChange, label = '무엇을 만들까요?', variant = 'compact' }: {
  value?: string;
  disabled?: boolean;
  onChange: (subjectId: string) => void;
  label?: string;
  variant?: 'compact' | 'cards';
}) {
  const selected = creationSubjects.find(subject => subject.id === value);
  const [group, setGroup] = useState<CreationSubjectGroup>(selected?.group ?? 'living');
  useEffect(() => { if (selected) setGroup(selected.group); }, [value]);
  const description = creationSubjectGroups.find(item => item.id === group)!.description;
  return <fieldset className={`gs-subject-chooser${variant === 'cards' ? ' gs-subject-cards' : ''}`} disabled={disabled} data-testid="creation-subject-chooser">
    <legend>{label}</legend>
    {variant === 'cards' && <h3>1. 분류</h3>}
    <div className="gs-subject-groups" role="group" aria-label="오브젝트 분류">
      {creationSubjectGroups.map(item => { const Icon = groupIcons[item.id]; return <button type="button" key={item.id}
        aria-label={item.label} aria-pressed={group === item.id} onClick={() => setGroup(item.id)}>{variant === 'cards' && <Icon size={22} aria-hidden="true" />}<span>{item.label}</span>{variant === 'cards' && <small aria-hidden="true">{cardDescriptions[item.id]}</small>}</button>; })}
    </div>
    {variant === 'cards' && <h3>2. 만들 대상</h3>}
    <div className="gs-subject-targets" role="group" aria-label="만들 대상 선택">
      {creationSubjects.filter(subject => subject.group === group && (!subject.legacy || subject.id === value)).map(subject =>
        <button type="button" key={subject.id} aria-pressed={value === subject.id}
          onClick={() => onChange(value === subject.id ? '' : subject.id)}>{subject.label}{variant === 'cards' && value === subject.id && <Check size={17} aria-hidden="true" />}</button>)}
    </div>
    <p className="gs-subject-description">{description}</p>
    <p className="gs-subject-current" aria-live="polite">{selected ? `선택: ${selected.label}` : '만들 대상을 선택하세요.'}</p>
  </fieldset>;
}

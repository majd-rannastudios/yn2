import { useEffect, useState } from 'react';

const initials = name => name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

/**
 * One person in a group or wrap-up: photo (or initials), name, role, Yarnoo link,
 * optional favorite toggle for signed-in members.
 */
export function PersonRow({ person, color, onFavorite }) {
  const [photo, setPhoto] = useState(null);

  useEffect(() => {
    if (!person.avatarUrl) { setPhoto(null); return; }
    const img = new Image();
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => setPhoto(img.src);
    img.src = person.avatarUrl;
  }, [person.avatarUrl]);

  return (
    <li className="person">
      <div className="avatar" style={{ background: color.hex, color: color.ink }}>
        {photo ? <img src={photo} alt="" referrerPolicy="no-referrer" /> : initials(person.name)}
      </div>
      <div className="person-text">
        <div className="person-name">{person.name}</div>
        <div className="person-meta">{[person.role, person.company].filter(Boolean).join(' · ')}</div>
      </div>
      {person.canFavorite && onFavorite && (
        <button
          type="button"
          className={`fav-btn${person.favorited ? ' on' : ''}`}
          aria-label={person.favorited ? `Unfavorite ${person.name}` : `Favorite ${person.name}`}
          aria-pressed={!!person.favorited}
          onClick={() => onFavorite(person)}
        >
          {person.favorited ? '♥' : '♡'}
        </button>
      )}
      {person.profileUrl && (
        <a
          className="person-link"
          href={person.profileUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${person.name} on Yarnoo`}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" /></svg>
        </a>
      )}
    </li>
  );
}

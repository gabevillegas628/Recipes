import { thumbUrl } from '../api';

/** Up to four recipe photos in a grid, or the meal's initial when there are none. */
export function Collage({ images, name, className = '' }: { images: string[]; name: string; className?: string }) {
  const shown = images.slice(0, 4);
  if (shown.length === 0) {
    return <div className={`collage collage-empty ${className}`}>{name.charAt(0).toUpperCase()}</div>;
  }
  return (
    <div className={`collage collage-${shown.length} ${className}`}>
      {shown.map((img) => (
        <img key={img} src={thumbUrl(img)!} alt="" loading="lazy" />
      ))}
    </div>
  );
}

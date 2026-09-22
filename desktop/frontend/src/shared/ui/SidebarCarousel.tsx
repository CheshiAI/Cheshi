import { useId, type ReactNode } from 'react';
import { useSidebarSwipe } from './useSidebarSwipe';
import styles from './SidebarCarousel.module.css';

export interface SidebarSlide {
  id: string;
  label: string;
  content: ReactNode;
}

export function SidebarCarousel({ slides, activeId, onSelect }: {
  slides: readonly SidebarSlide[];
  activeId: string;
  onSelect(id: string): void;
}) {
  const id = useId();
  const index = Math.max(0, slides.findIndex(slide => slide.id === activeId));
  const { surface, track, previewIndex, cancelSwipe } = useSidebarSwipe(index, slides.map(slide => slide.id), onSelect);
  const select = (slideId: string) => { cancelSwipe(); onSelect(slideId); };
  return <div ref={surface} className={styles.carousel} role="region" aria-label="Sidebar panels" aria-roledescription="carousel">
    <div className={styles.viewport}>
      <div ref={track} className={styles.track} style={{ transform: `translateX(calc(-${index * 100}% + var(--sidebar-swipe-offset, 0px)))` }}>
        {slides.map((slide, position) => <div key={slide.id} id={`${id}-${slide.id}`}
          className={styles.panel} role="group" aria-roledescription="slide"
          aria-label={`${slide.label} (${position + 1} of ${slides.length})`}
          aria-hidden={position !== index} inert={position !== index}>
          {slide.content}
        </div>)}
      </div>
    </div>
    {slides.length > 1 && <div className={styles.pagination} role="group" aria-label="Choose sidebar panel">
      {slides.map((slide, position) => <button key={slide.id} type="button" className={styles.dot}
        aria-label={`Show ${slide.label}`} title={slide.label} aria-controls={`${id}-${slide.id}`}
        data-highlighted={position === (previewIndex ?? index)}
        aria-pressed={position === index} onClick={() => select(slide.id)}
        onKeyDown={event => {
          let next: number;
          switch (event.key) {
            case 'ArrowLeft': next = (position + slides.length - 1) % slides.length; break;
            case 'ArrowRight': next = (position + 1) % slides.length; break;
            case 'Home': next = 0; break;
            case 'End': next = slides.length - 1; break;
            default: return;
          }
          event.preventDefault();
          event.stopPropagation();
          select(slides[next]!.id);
          event.currentTarget.parentElement?.querySelectorAll('button')[next]?.focus();
        }}><span aria-hidden="true" /></button>)}
    </div>}
  </div>;
}

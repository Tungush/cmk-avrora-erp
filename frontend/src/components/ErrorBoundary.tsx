import React from 'react';

/**
 * Граница ошибок раздела (03.09.2026).
 *
 * До неё падение одного экрана размонтировало всё приложение: белый
 * (точнее, серый) экран без единого слова. Теперь ломается только
 * раздел, а меню, шапка и остальные разделы живы — человек видит,
 * что случилось, и может уйти в другой раздел или обновить.
 */
interface State { error: Error | null }

export class SectionErrorBoundary extends React.Component<{ children: React.ReactNode; resetKey?: string }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    // Переход в другой раздел сбрасывает ошибку: она была про прошлый
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[section] раздел упал:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="section-crash" role="alert">
        <div className="section-crash__title">Раздел не открылся</div>
        <div className="section-crash__msg">{this.state.error.message}</div>
        <button type="button" className="digest-card__action" style={{ width: 'auto', padding: '0 18px' }}
          onClick={() => this.setState({ error: null })}>
          Попробовать снова
        </button>
      </div>
    );
  }
}

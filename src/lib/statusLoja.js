const TIMEZONE = 'America/Sao_Paulo';

/** dia da semana (0=domingo...6=sábado) e "HH:mm" atuais no fuso da loja, sem depender do TZ do servidor. */
const agoraNoFuso = () => {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const DIAS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = partes.find((p) => p.type === 'weekday')?.value;
  const hour = partes.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = partes.find((p) => p.type === 'minute')?.value ?? '00';

  return { diaSemana: DIAS[weekday] ?? 0, horaAtual: `${hour === '24' ? '00' : hour}:${minute}` };
};

/**
 * Calcula se a loja está aberta agora, combinando o botão manual de emergência com o
 * horário automático por dia da semana (quando habilitado).
 * @param {{lojaAbertaManual: boolean, usarHorarioAutomatico: boolean}} empresa
 * @param {{diaSemana: number, abre: string|null, fecha: string|null, fechado: boolean}[]} horarios
 * @returns {{aberta: boolean, motivo: 'fechado_manual'|'fora_do_horario'|'sem_horario_definido'|null}}
 */
const calcularStatusLoja = (empresa, horarios = []) => {
  if (!empresa.lojaAbertaManual) {
    return { aberta: false, motivo: 'fechado_manual' };
  }

  if (!empresa.usarHorarioAutomatico) {
    return { aberta: true, motivo: null };
  }

  const { diaSemana, horaAtual } = agoraNoFuso();
  const horarioHoje = horarios.find((h) => h.diaSemana === diaSemana);

  if (!horarioHoje || horarioHoje.fechado || !horarioHoje.abre || !horarioHoje.fecha) {
    return { aberta: false, motivo: horarioHoje ? 'fora_do_horario' : 'sem_horario_definido' };
  }

  const dentro = horarioHoje.abre <= horarioHoje.fecha
    ? horaAtual >= horarioHoje.abre && horaAtual < horarioHoje.fecha
    // faixa que cruza a meia-noite (ex: 18:00 -> 02:00)
    : horaAtual >= horarioHoje.abre || horaAtual < horarioHoje.fecha;

  return { aberta: dentro, motivo: dentro ? null : 'fora_do_horario' };
};

module.exports = { calcularStatusLoja };

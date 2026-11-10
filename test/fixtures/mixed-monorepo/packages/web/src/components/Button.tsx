import React from 'react';

export function Button(props: { label: string }) {
  return <button type="button">{props.label}</button>;
}

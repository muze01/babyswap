import React, { ReactNode, useEffect } from 'react';

// Modal Component Types
export interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    children: ReactNode;
    className?: string;
}

const Modal: React.FC<ModalProps> = ({
    isOpen,
    onClose,
    children,
    className = ''
}) => {
    // Handle escape key to close modal
    useEffect(() => {
        const handleEscapeKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onClose();
            }
        };

        if (isOpen) {
            document.addEventListener('keydown', handleEscapeKey);
            // Prevent scrolling on body when modal is open
            document.body.style.overflow = 'hidden';
        }

        // Cleanup
        return () => {
            document.removeEventListener('keydown', handleEscapeKey);
            document.body.style.overflow = 'unset';
        };
    }, [isOpen, onClose]);

    // If modal is not open, render nothing
    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
            onClick={onClose}
        >
            {/* Prevent click propagation to close modal when clicking inside */}
            <div
                className={`bg-gray-800 rounded-lg shadow-xl relative ${className}`}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Optional close button */}
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 text-white hover:text-gray-300"
                >
                    ✕
                </button>

                {children}
            </div>
        </div>
    );
};

export default Modal;